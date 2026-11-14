import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../../sync/RemoteSyncStateApplier';
import { SharedStateFile } from '../../sync/SharedStateFile';
import { SyncManager } from '../../sync/SyncManager';
import { RemoteSyncDelivery } from '../../sync/SyncReconciler';

/**
 * #137 item 3: a publish whose write keeps failing must be retried with a
 * bounded backoff, cancelled by stop and superseded by a newer local commit;
 * while such a commit is still unpublished, an older remote state must not
 * silently overwrite it.
 */
suite('Failed publish retry (#137)', function() {
    this.timeout(20000);

    let testDir: string;
    let managers: SyncManager[];
    let restorers: Array<() => void>;
    let stateFilePath: string;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-pubretry-'));
        stateFilePath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
        managers = [];
        restorers = [];
    });

    teardown(async () => {
        for (const restore of restorers) {
            restore();
        }
        restorers = [];
        for (const manager of managers) {
            await manager.stop();
        }
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    function mockConfig() {
        return {
            isSyncEnabled: () => true,
            // Long interval: deliveries are driven by triggerSync(), not the poll.
            getSyncInterval: () => 3_600_000,
            onConfigChange: () => ({ dispose: () => undefined }),
            dispose: () => undefined
        };
    }

    interface ManagerOptions {
        publishRetryDelaysMs?: readonly number[];
        publishRetryRandom?: () => number;
    }

    async function startQuiet(windowId: string, options: ManagerOptions = {}): Promise<SyncManager> {
        const manager = new SyncManager(testDir, windowId, mockConfig() as never, 'test');
        managers.push(manager);
        const tunables = manager as unknown as ManagerOptions;
        if (options.publishRetryDelaysMs) {
            tunables.publishRetryDelaysMs = options.publishRetryDelaysMs;
        }
        if (options.publishRetryRandom) {
            tunables.publishRetryRandom = options.publishRetryRandom;
        }
        await manager.start();
        // Determinism: the watcher debounce could collapse quick writes into
        // one delivery. Deliveries here come from triggerSync().
        (manager as unknown as { fileWatcher: { stop(): void } }).fileWatcher.stop();
        return manager;
    }

    interface LocalStore {
        getState(): Promise<ProxyState>;
        saveState(state: ProxyState): Promise<void>;
        commitState(expectedRevision: number, next: ProxyState): Promise<StateCommitResult>;
        readonly revision: number;
        readonly stored: ProxyState;
    }

    /** Local persist semantics of ProxyStateManager: revision = max(stored, next)+1, CAS commit. */
    function createLocalStore(initial: ProxyState): LocalStore {
        let revision = stateRevision(initial);
        let stored: ProxyState = { ...initial, revision };
        return {
            getState: async () => ({ ...stored }),
            saveState: async (next: ProxyState) => {
                revision = Math.max(revision, stateRevision(next)) + 1;
                stored = { ...next, revision };
            },
            commitState: async (expectedRevision: number, next: ProxyState) => {
                if (revision !== expectedRevision) {
                    return { kind: 'superseded', current: { ...stored } };
                }
                revision = expectedRevision + 1;
                stored = { ...next, revision };
                return { kind: 'committed', revision, state: { ...stored } };
            },
            get revision() { return revision; },
            get stored() { return { ...stored }; }
        };
    }

    interface ReceiverProbe {
        deliveries: Promise<unknown>[];
        applyCalls: Array<{ url: string; enabled: boolean }>;
        failures: unknown[];
    }

    /** The same wiring registerSyncEventHandlers uses, against a fake local store. */
    function wireReceiver(manager: SyncManager, store: LocalStore, probe: ReceiverProbe): void {
        manager.on('remoteChange', (delivery: RemoteSyncDelivery) => {
            const context = (adopted: () => Promise<boolean>): RemoteSyncApplyContext => ({
                saveState: async state => { await store.saveState(state); },
                getState: () => store.getState(),
                commitState: (expected, next) => store.commitState(expected, next),
                getActiveProxyUrl: current => current.mode === ProxyMode.Auto && !current.autoModeOff
                    ? current.autoProxyUrl || ''
                    : '',
                applyProxy: async (url, enabled) => { probe.applyCalls.push({ url, enabled }); return true; },
                startMonitoring: async () => undefined,
                stopMonitoring: async () => undefined,
                updateStatus: () => undefined,
                adoptRemoteState: adopted
            });
            probe.deliveries.push(manager.absorbRemoteChange(
                delivery,
                async state => {
                    await store.saveState(state);
                    return store.revision;
                },
                adopted => applyRemoteSyncState(delivery.state, context(adopted))
            ).catch(error => probe.failures.push(error)));
        });
    }

    function createProbe(): ReceiverProbe {
        return { deliveries: [], applyCalls: [], failures: [] };
    }

    async function waitFor(condition: () => boolean | Promise<boolean>, what: string, ms = 8_000): Promise<void> {
        const start = Date.now();
        while (!(await condition())) {
            if (Date.now() - start > ms) {
                throw new Error(`timed out waiting for: ${what}`);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    async function readShared(): Promise<{ version: number; proxyState: ProxyState; lastModifiedBy: string } | null> {
        return await new SharedStateFile(testDir).read();
    }

    /**
     * Makes fs.renameSync throw EPERM while `block()` holds, only for renames
     * that target the shared state file and whose temp payload `match`es.
     * Records the timestamp of every matching attempt.
     */
    function failRenames(match: (tempContent: string) => boolean, block: () => boolean) {
        // Patch the real fs object: every `import * as fs` wrapper forwards
        // through getters, so this intercepts SharedStateFile's calls too
        // (sinon cannot stub the getter-only wrapper namespace).
        const fsm = require('fs') as { renameSync: (from: unknown, to: unknown) => void };
        const realRenameSync = fsm.renameSync;
        const attempts: number[] = [];
        fsm.renameSync = (from: unknown, to: unknown): void => {
            if (String(to) === stateFilePath) {
                const content = fs.readFileSync(from as fs.PathLike, 'utf-8');
                if (match(content)) {
                    attempts.push(Date.now());
                    if (block()) {
                        const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
                        error.code = 'EPERM';
                        throw error;
                    }
                }
            }
            return realRenameSync(from, to);
        };
        restorers.push(() => { fsm.renameSync = realRenameSync; });
        return attempts;
    }

    test('a failed publish is retried with backoff until it lands', async () => {
        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 4 });

        const aManager = await startQuiet('window-a', { publishRetryDelaysMs: [40, 80], publishRetryRandom: () => 0.5 });
        // The shared file's atomic rename retries 5 times inside one write;
        // failing exactly 5 attempts kills the first publish only.
        let calls = 0;
        const attempts = failRenames(() => true, () => ++calls <= 5);

        await aManager.notifyChange({ mode: ProxyMode.Off, revision: 9 });
        assert.strictEqual(attempts.length, 5, 'the first publish must have exhausted its rename attempts');

        await waitFor(async () => (await readShared())?.proxyState.mode === ProxyMode.Off, 'the retried publish to land');
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Off);
        assert.strictEqual(shared?.version, 2, 'the retried publish lands on top of the observed version');
        assert.strictEqual(aManager.getSyncStatus().lastError, null, 'a successful retry clears the error');

        // The retry waited for its scheduled delay instead of looping immediately.
        assert.ok(attempts.length >= 6, 'at least one retry attempt happened');
        const backoffMs = attempts[5] - attempts[4];
        assert.ok(backoffMs >= 20, `retry fired too early (${backoffMs}ms < 20ms): no backoff`);
    });

    test('an older remote state does not silently overwrite an unpublished local commit', async () => {
        // A starts before B publishes so the first delivery is a real remote
        // adoption (a state present at start() is only loaded, not delivered).
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-old.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a', { publishRetryDelaysMs: [300, 600], publishRetryRandom: () => 0.5 });
        wireReceiver(aManager, aStore, aProbe);

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 4 });

        // A adopts B's v1 through the production path.
        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 1, 'adoption of v1');
        await Promise.all(aProbe.deliveries);
        assert.strictEqual(aStore.stored.mode, ProxyMode.Auto);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://proxy.example:8080');

        // The user toggles Off in A; every write of that commit is refused.
        let blockOffWrites = true;
        failRenames(
            content => content.includes('"mode": "off"'),
            () => blockOffWrites
        );
        await aStore.saveState({ mode: ProxyMode.Off });
        await aManager.notifyChange(aStore.stored);
        assert.ok(aManager.getSyncStatus().lastError, 'the failed publish records an error');

        // B's next scheduled publication (still Auto) lands while A's commit
        // is unpublished: it must not roll A's local commit back.
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 5, lastTestTimestamp: 1 });
        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 2, 'delivery of v2');
        await Promise.all(aProbe.deliveries);

        assert.strictEqual(aStore.stored.mode, ProxyMode.Off, 'the older remote state must not overwrite the unpublished commit');
        assert.ok(aManager.getSyncStatus().lastError, 'the undelivered commit must keep its error');

        // Once the write path recovers, the retried commit lands on top of v2.
        blockOffWrites = false;
        await waitFor(async () => (await readShared())?.proxyState.mode === ProxyMode.Off, 'the retried Off commit');
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Off);
        assert.strictEqual(shared?.version, 3, 'the retried commit is published on top of the remote v2');
        assert.strictEqual(aStore.stored.mode, ProxyMode.Off, 'the local commit was never rolled back');
    });

    test('exhausted retries hand the window back to the current shared state', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-old.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a', { publishRetryDelaysMs: [200, 300], publishRetryRandom: () => 0.5 });
        wireReceiver(aManager, aStore, aProbe);

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 4 });

        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 1, 'adoption of v1');
        await Promise.all(aProbe.deliveries);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://proxy.example:8080', 'v1 was adopted');

        // A's Off commit never lands: the retry budget is spent quickly.
        failRenames(content => content.includes('"mode": "off"'), () => true);
        await aStore.saveState({ mode: ProxyMode.Off });
        await aManager.notifyChange(aStore.stored);

        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 5, lastTestTimestamp: 2 });
        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 2, 'delivery of v2');
        await Promise.all(aProbe.deliveries);
        assert.strictEqual(aStore.stored.mode, ProxyMode.Off, 'still blocked while the commit is being retried');

        // With the retries exhausted, the window converges to the shared state
        // instead of staying diverged forever.
        await waitFor(() => aStore.stored.mode === ProxyMode.Auto, 'A to adopt the shared state after the retries gave out');
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Auto);
    });

    test('exhausted retries re-adopt the shared state even when its version never moved', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-old.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a', { publishRetryDelaysMs: [50, 80], publishRetryRandom: () => 0.5 });
        wireReceiver(aManager, aStore, aProbe);

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080', revision: 4 });

        // A adopts B's v1: the shared-version watermark is now 1.
        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 1, 'adoption of v1');
        await Promise.all(aProbe.deliveries);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://proxy.example:8080', 'v1 was adopted');

        // A commits Off; every attempt to publish it fails, and no other
        // window writes: the on-disk version stays 1, equal to the watermark.
        failRenames(content => content.includes('"mode": "off"'), () => true);
        await aStore.saveState({ mode: ProxyMode.Off });
        await aManager.notifyChange(aStore.stored);

        // Once the retry budget is spent the window must re-adopt the shared
        // state even though its version never moved (#137): without a forced
        // adoption the watermark suppresses exactly this delivery and the
        // window stays on its unpublished commit forever.
        await waitFor(() => aStore.stored.mode === ProxyMode.Auto,
            'A to re-adopt the unchanged shared version after the retries gave out');
        const shared = await readShared();
        assert.strictEqual(shared?.version, 1, 'no newer remote version was written');
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Auto);
    });

    test('a newer local publish supersedes the pending retry; stop cancels it', async () => {
        const aManager = await startQuiet('window-a', { publishRetryDelaysMs: [80, 160], publishRetryRandom: () => 0.5 });

        let blockOffWrites = true;
        failRenames(content => content.includes('"mode": "off"'), () => blockOffWrites);
        await aManager.notifyChange({ mode: ProxyMode.Off, revision: 9 });
        assert.ok(aManager.getSyncStatus().lastError, 'the failed publish records an error');

        // A newer local commit lands while the Off retry is still pending:
        // the pending snapshot is stale and must never be written.
        blockOffWrites = false;
        await aManager.notifyChange({ mode: ProxyMode.Manual, manualProxyUrl: 'http://manual.example:8080', revision: 10 });
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Manual);

        // Give the dropped retry every chance to fire.
        await new Promise(resolve => setTimeout(resolve, 300));
        const afterWait = await readShared();
        assert.strictEqual(afterWait?.proxyState.mode, ProxyMode.Manual, 'the superseded Off commit must never land');
        assert.ok(afterWait?.proxyState.manualProxyUrl?.includes('manual.example'), 'the Manual commit kept its URL');

        // A pending retry does not outlive stop().
        blockOffWrites = true;
        await aManager.notifyChange({ mode: ProxyMode.Off, revision: 11 });
        await aManager.stop();
        blockOffWrites = false;
        await new Promise(resolve => setTimeout(resolve, 300));
        const afterStop = await readShared();
        assert.strictEqual(afterStop?.proxyState.mode, ProxyMode.Manual, 'stop must cancel the pending retry');
    });
});
