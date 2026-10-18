import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commitUnlessStale, publishUnlessStale } from '../../core/GenerationFence';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../../sync/RemoteSyncStateApplier';
import { SharedStateFile } from '../../sync/SharedStateFile';
import { SyncManager } from '../../sync/SyncManager';
import { RemoteSyncDelivery } from '../../sync/SyncReconciler';
import { UNRESOLVED_LOCAL_CREDENTIAL_ERROR } from '../../utils/ProxyStateSanitizer';

/**
 * Cross-window ordering for #108: the shared file's `version` orders states
 * between windows; a window's `revision` is a local fence only. Exercises
 * real SyncManager instances over one temporary sync directory, the real
 * applyRemoteSyncState, and the production absorbRemoteChange owner.
 */
suite('Cross-window sync ordering (#108)', function() {
    this.timeout(30000);

    let testDir: string;
    let managers: SyncManager[];

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-order-'));
        managers = [];
    });

    teardown(async () => {
        for (const manager of managers) {
            await manager.stop();
        }
        fs.rmSync(testDir, { recursive: true, force: true });
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

    async function startQuiet(windowId: string): Promise<SyncManager> {
        const manager = new SyncManager(testDir, windowId, mockConfig() as never, 'test');
        managers.push(manager);
        await manager.start();
        // Determinism: the 100ms watcher debounce could collapse two quick
        // writes into one delivery. Deliveries here come from triggerSync().
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
        applyCalls: Array<{ url: string; enabled: boolean }>;
        monitoring: string[];
        statusUpdates: number;
        saves: number;
        failures: unknown[];
        /** Set to hold applyProxy until released. */
        applyGate: { promise: Promise<void>; release(): void } | null;
        applyEnterOrder: string[];
        applyExitOrder: string[];
        /** The absorbRemoteChange promise of every emitted delivery. */
        deliveries: Promise<unknown>[];
    }

    function deferred(): { promise: Promise<void>; release(): void } {
        let release!: () => void;
        return { promise: new Promise<void>(resolve => { release = resolve; }), release };
    }

    /** The same wiring registerSyncEventHandlers uses, against a fake context. */
    function wireReceiver(
        manager: SyncManager,
        store: LocalStore,
        probe: ReceiverProbe,
        overrides: Partial<RemoteSyncApplyContext> = {}
    ): (adopted: () => Promise<boolean>) => RemoteSyncApplyContext {
        const context = (adopted: () => Promise<boolean>): RemoteSyncApplyContext => ({
            saveState: async state => { probe.saves++; await store.saveState(state); },
            getState: () => store.getState(),
            commitState: (expected, next) => store.commitState(expected, next),
            getActiveProxyUrl: current => current.mode === ProxyMode.Auto && !current.autoModeOff
                ? current.autoProxyUrl || ''
                : '',
            applyProxy: async (url, enabled) => {
                probe.applyEnterOrder.push(url);
                probe.applyCalls.push({ url, enabled });
                await probe.applyGate?.promise;
                probe.applyExitOrder.push(url);
                return true;
            },
            startMonitoring: async () => { probe.monitoring.push('start'); },
            stopMonitoring: async () => { probe.monitoring.push('stop'); },
            updateStatus: () => { probe.statusUpdates++; },
            ...overrides,
            adoptRemoteState: adopted
        });
        manager.on('remoteChange', (delivery: RemoteSyncDelivery) => {
            probe.deliveries.push(manager.absorbRemoteChange(
                delivery,
                async state => {
                    probe.saves++;
                    await store.saveState(state);
                    return store.revision;
                },
                adopted => applyRemoteSyncState(delivery.state, context(adopted))
            ).catch(error => probe.failures.push(error)));
        });
        return context;
    }

    function createProbe(): ReceiverProbe {
        return {
            applyCalls: [],
            statusUpdates: 0,
            monitoring: [],
            saves: 0,
            failures: [],
            applyGate: null,
            applyEnterOrder: [],
            applyExitOrder: [],
            deliveries: []
        };
    }

    async function waitFor(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
        const start = Date.now();
        while (!condition()) {
            if (Date.now() - start > ms) {
                throw new Error(`timed out waiting for: ${what}`);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /** Rejects with a named deadlock error when the promise does not settle in time. */
    async function settleWithin<T>(promise: Promise<T>, what: string, ms = 5_000): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<T>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`deadlock: ${what} did not settle within ${ms} ms`)), ms);
                })
            ]);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    async function readShared(): Promise<{ version: number; proxyState: ProxyState } | null> {
        return await new SharedStateFile(testDir).read();
    }

    test('a window whose revision is far ahead still absorbs a quiet window toggle', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-old.example:8080' });
        for (let i = 0; i < 5; i++) {
            await aStore.saveState({ ...aStore.stored, lastTestTimestamp: i });
        }
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe);

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b.example:8080',
            revision: 1
        });

        await aManager.triggerSync();
        await waitFor(() => aProbe.applyCalls.length === 1, 'apply of the remote state');

        assert.deepStrictEqual(aProbe.applyCalls, [{ url: 'http://b.example:8080', enabled: true }]);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://b.example:8080');
        assert.deepStrictEqual(aProbe.failures, []);
    });

    test('a publication from a window behind the disk revision is not discarded', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe);

        // Window A published a busy Auto history: the shared file carries a
        // high per-window revision that used to discard B's publication.
        for (let i = 1; i <= 4; i++) {
            await aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: `http://a-${i}.example:8080` });
            await aManager.notifyChange(aStore.stored);
        }
        const before = await readShared();
        assert.strictEqual(before?.proxyState.autoProxyUrl, 'http://a-4.example:8080');

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b-quiet.example:8080',
            revision: 1
        });

        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://b-quiet.example:8080');

        await aManager.triggerSync();
        await waitFor(() => aProbe.applyCalls.length === 1, 'apply of the quiet window state');
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://b-quiet.example:8080');
    });

    test('a late local publication of an older snapshot is still discarded (#17)', async () => {
        const aManager = await startQuiet('window-a');

        const rev1: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: 'http://n.example:8080', revision: 1 };
        const rev2: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: 'http://n-plus-1.example:8080', revision: 2 };

        await aManager.notifyChange(rev1);
        await aManager.notifyChange(rev2);
        await aManager.notifyChange(rev1);

        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://n-plus-1.example:8080');
    });

    test('a snapshot captured before an adoption is discarded after it (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-1.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe);

        await aManager.notifyChange(aStore.stored); // published at local rev 1

        await aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-2.example:8080' });
        const heldSnapshot = aStore.stored; // local rev 2, never published

        const bManager = await startQuiet('window-b');
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://b.example:8080', revision: 1 });
        await aManager.triggerSync();
        await waitFor(() => aStore.stored.autoProxyUrl === 'http://b.example:8080', 'adoption of the remote state');

        await aManager.notifyChange(heldSnapshot);
        let shared = await readShared();
        assert.strictEqual(
            shared?.proxyState.autoProxyUrl,
            'http://b.example:8080',
            'the pre-adoption snapshot must not overwrite the adopted state'
        );

        await aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-3.example:8080' });
        await aManager.notifyChange(aStore.stored);
        shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://a-3.example:8080');
    });

    test('a delivery superseded by this window publication is skipped (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-1.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        const context = wireReceiver(aManager, aStore, aProbe);
        const bManager = await startQuiet('window-b');

        // B publishes the second state; record the shared version it got.
        const d2: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: 'http://b-2.example:8080', revision: 2 };
        await bManager.notifyChange(d2);
        const d2Shared = await readShared();
        assert.ok(d2Shared, 'B\'s publication reached the shared file');
        const d2Version = d2Shared.version;

        // This window's publication enters the transition section first:
        // notifyChange enqueues synchronously at the call, before the
        // delivery's adoption is enqueued by the absorbRemoteChange below.
        await aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-new.example:8080' });
        void aManager.notifyChange(aStore.stored);

        // The delivery's adoption is enqueued after the publication, so the
        // version check sees a watermark already above the delivery.
        await aManager.absorbRemoteChange(
            { state: d2, version: d2Version },
            async state => {
                aProbe.saves++;
                await aStore.saveState(state);
                return aStore.revision;
            },
            adopted => applyRemoteSyncState(d2, context(adopted))
        );

        assert.strictEqual(aProbe.saves, 0, 'a superseded delivery saves nothing');
        assert.strictEqual(aProbe.statusUpdates, 0, 'a superseded delivery updates no status');
        assert.deepStrictEqual(aProbe.applyCalls, []);
        assert.deepStrictEqual(aProbe.monitoring, []);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://a-new.example:8080');
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://a-new.example:8080',
            'this window\'s local state equals the shared file (its own publication)');
    });

    test('remote deliveries are absorbed in emission order, one at a time (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe);
        const bManager = await startQuiet('window-b');

        aProbe.applyGate = deferred();
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://first.example:8080', revision: 1 });
        await aManager.triggerSync();
        await waitFor(() => aProbe.applyEnterOrder.length === 1, 'first delivery inside its apply');

        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://second.example:8080', revision: 2 });
        await aManager.triggerSync();
        await waitFor(() => aProbe.deliveries.length === 2, 'second delivery queued');

        // The first apply stays held; nothing may let the second delivery's
        // convergence reach its apply in the meantime. A bounded drain gives
        // an unordered implementation every turn it would need.
        for (let i = 0; i < 50 && aProbe.applyEnterOrder.length === 1; i++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepStrictEqual(aProbe.applyEnterOrder, ['http://first.example:8080'],
            'the second delivery must not enter its apply while the first is held');

        aProbe.applyGate.release();
        await Promise.all(aProbe.deliveries);

        assert.deepStrictEqual(aProbe.applyEnterOrder, ['http://first.example:8080', 'http://second.example:8080']);
        assert.deepStrictEqual(aProbe.applyExitOrder, ['http://first.example:8080', 'http://second.example:8080']);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://second.example:8080');
    });

    test('a delivery whose monitoring start publishes does not deadlock (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe, {
            // The production startSystemProxyMonitoring reaches notifyChange
            // through the detection path and awaits it; reproduced directly.
            startMonitoring: async () => {
                aProbe.monitoring.push('start');
                await aManager.notifyChange(aStore.stored);
            }
        });
        const bManager = await startQuiet('window-b');

        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://b.example:8080', revision: 1 });

        await aManager.triggerSync();
        await waitFor(
            () => aProbe.applyExitOrder.length === 1 && aProbe.monitoring.includes('start'),
            'delivery whose startMonitoring publishes through the same SyncManager'
        );
        await settleWithin(Promise.all(aProbe.deliveries), 'the delivery chain');

        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://b.example:8080');
        assert.ok((shared?.version ?? 0) >= 2, 'the monitoring publication reached the file');
        assert.deepStrictEqual(aProbe.failures, []);
    });

    test('a delivery whose monitoring stop awaits a concurrent publication does not deadlock (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        let inFlightPublish: Promise<void> | undefined;
        wireReceiver(aManager, aStore, aProbe, {
            applyProxy: async (url, enabled) => {
                aProbe.applyEnterOrder.push(url);
                aProbe.applyCalls.push({ url, enabled });
                // Another caller (e.g. a scheduled test result) publishes
                // while this delivery is still applying.
                inFlightPublish = aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-2.example:8080' })
                    .then(() => aManager.notifyChange(aStore.stored));
                await new Promise(resolve => setTimeout(resolve, 10));
                aProbe.applyExitOrder.push(url);
                return true;
            },
            stopMonitoring: async () => {
                aProbe.monitoring.push('stop');
                await inFlightPublish;
            }
        });
        const bManager = await startQuiet('window-b');

        await bManager.notifyChange({ mode: ProxyMode.Off, revision: 1 });
        await aManager.triggerSync();
        await waitFor(
            () => aProbe.applyExitOrder.length === 1 && aProbe.monitoring.includes('stop'),
            'delivery whose stopMonitoring awaits a publication started mid-apply'
        );
        await settleWithin(Promise.all(aProbe.deliveries), 'the delivery chain');
        assert.ok(inFlightPublish, 'the concurrent publication was started during the apply');
        await settleWithin(inFlightPublish, 'the publication started during the apply');
        const sharedAfter = await readShared();
        assert.strictEqual(sharedAfter?.proxyState.autoProxyUrl, 'http://a-2.example:8080',
            'the publication started during the apply reached the shared file');
        assert.deepStrictEqual(aProbe.failures, []);
    });

    test('a reassert does not supersede a delivery pending on the delivery chain (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        wireReceiver(aManager, aStore, aProbe);
        const bManager = await startQuiet('window-b');
        const sharedFile = new SharedStateFile(testDir);

        // D0 holds the delivery chain inside its apply. D is adopted when it is
        // emitted; only its apply waits behind D0's.
        aProbe.applyGate = deferred();
        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://d0.example:8080', revision: 1 });
        await aManager.triggerSync();
        await waitFor(() => aProbe.applyEnterOrder.length === 1, 'first delivery inside its apply');

        await bManager.notifyChange({ mode: ProxyMode.Auto, autoProxyUrl: 'http://d1.example:8080', revision: 2 });
        await aManager.triggerSync(); // emits D; queues behind D0

        // The shared file drops below the remembered version: corrupted-file
        // recovery. The reconcile republishes the currently held state (D's
        // content) without touching the fence or the watermark.
        const lowered = await sharedFile.read();
        assert.ok(lowered);
        await sharedFile.write({
            version: 1,
            lastModified: Date.now(),
            lastModifiedBy: 'window-b',
            proxyState: { mode: ProxyMode.Off }
        });
        await aManager.triggerSync();

        aProbe.applyGate.release();
        await waitFor(() => aProbe.deliveries.length === 2, 'second delivery queued');
        await Promise.all(aProbe.deliveries);

        assert.deepStrictEqual(aProbe.applyEnterOrder, ['http://d0.example:8080', 'http://d1.example:8080']);
        assert.strictEqual(
            aStore.stored.autoProxyUrl,
            'http://d1.example:8080',
            'the pending delivery must still be adopted'
        );
        const shared = await readShared();
        assert.strictEqual(shared?.proxyState.autoProxyUrl, 'http://d1.example:8080');
    });

    test('a background result computed before a later delivery is not published over it (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        const detectionGate = deferred();
        let committed = 'unset';
        wireReceiver(aManager, aStore, aProbe, {
            // What SystemProxyUpdateService.saveAndPublishState does: capture
            // the generation before the async work, fence the commit and the
            // publication on it. Here the fence runs against the real store
            // and the real commitUnlessStale / publishUnlessStale.
            startMonitoring: async () => {
                aProbe.monitoring.push('start');
                const started = captureLogicalGeneration(await aStore.getState());
                await detectionGate.promise;
                const outcome = await commitUnlessStale(aStore, started, 'detection',
                    current => ({ ...current, autoProxyUrl: 'http://a-detected.example:8080' }));
                committed = outcome;
                if (outcome === 'committed') {
                    const current = await aStore.getState();
                    await publishUnlessStale(
                        state => aManager.notifyChange(state),
                        captureLogicalGeneration(current),
                        'detection',
                        current
                    );
                }
            }
        });
        const bManager = await startQuiet('window-b');

        // D1: B toggles to Auto. A adopts it at emission; its convergence
        // reaches startMonitoring, captures the generation, and waits.
        const d1: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: 'http://b-1.example:8080', revision: 1 };
        await bManager.notifyChange(d1);
        await aManager.triggerSync();
        await waitFor(() => aProbe.monitoring.length === 1, 'D1 inside the held monitoring step');

        // D2: B toggles back to Off while the gate is held. Its adoption runs
        // on the transition section at emission — before D1's convergence
        // finishes — so the generation the detection captured is already stale.
        const d2: ProxyState = { mode: ProxyMode.Off, revision: 2 };
        await bManager.notifyChange(d2);
        const d2Shared = await readShared();
        assert.strictEqual(d2Shared?.proxyState.mode, ProxyMode.Off);
        const d2Version = d2Shared!.version;
        await aManager.triggerSync();
        // Adoption is decided at emission; it is only a save plus two field
        // updates on the free section, so a bounded wait is plenty. The wait
        // is deliberately tolerant — under the mutation "adoption on the
        // delivery chain" D2 stays unadopted behind D1's held convergence,
        // and the release below reproduces the stale publication the
        // assertions then catch, instead of deadlocking the test itself.
        const adoptedDeadline = Date.now() + 2000;
        while (aStore.stored.mode !== ProxyMode.Off && Date.now() < adoptedDeadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        detectionGate.release();
        await waitFor(() => aProbe.deliveries.length === 2, 'both deliveries queued');
        await Promise.all(aProbe.deliveries);

        assert.strictEqual(committed, 'stale', 'the detection commit must be fenced by D2\'s adoption');
        const shared = await readShared();
        assert.strictEqual(shared?.version, d2Version,
            'the shared file still holds D2 at D2\'s version — A published nothing after it');
        assert.strictEqual(shared?.proxyState.mode, ProxyMode.Off);
        assert.strictEqual(aStore.stored.mode, ProxyMode.Off);
        assert.deepStrictEqual(
            aProbe.applyCalls[aProbe.applyCalls.length - 1],
            { url: '', enabled: false },
            'A\'s apply calls end with the disable'
        );
        assert.deepStrictEqual(aProbe.monitoring, ['start', 'stop']);
        assert.deepStrictEqual(aProbe.failures, []);
    });

    test('the credential gate write is fenced against a newer state (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        let statusUpdates = 0;
        let applyFailures = 0;
        const context = wireReceiver(aManager, aStore, aProbe, {
            updateStatus: () => { statusUpdates++; },
            onApplyFailure: () => { applyFailures++; },
            commitState: async (expected, next) => {
                // A newer state lands between the gate's read and its write —
                // a later delivery's adoption or a local commit.
                await aStore.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a-newer.example:8080' });
                return aStore.commitState(expected, next);
            }
        });

        // A delivery whose active URL requires credentials this window lacks.
        const deliveryState: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://needs-auth.example:8080',
            requiresAuth: true,
            revision: 1
        };
        await aManager.absorbRemoteChange(
            { state: deliveryState, version: 1 },
            async state => {
                await aStore.saveState(state);
                return aStore.revision;
            },
            adopted => applyRemoteSyncState(deliveryState, context(adopted))
        );

        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://a-newer.example:8080',
            'the newer state survives the gate write');
        assert.strictEqual(aStore.stored.lastError, undefined,
            'no stale lastError was written over the newer state');
        assert.strictEqual(statusUpdates, 0, 'status untouched on a stale gate write');
        assert.strictEqual(applyFailures, 0, 'onApplyFailure not called on a stale gate write');
        assert.deepStrictEqual(aProbe.monitoring, [], 'monitoring untouched on a stale gate write');
        assert.deepStrictEqual(aProbe.applyCalls, [], 'nothing applied');
        assert.deepStrictEqual(aProbe.failures, []);
    });

    test('a revision-only commit between the gate read and write is refolded, not dropped (#108)', async () => {
        const aStore = createLocalStore({ mode: ProxyMode.Off });
        const aProbe = createProbe();
        const aManager = await startQuiet('window-a');
        let statusUpdates = 0;
        let applyFailures = 0;
        let gateCommits = 0;
        const context = wireReceiver(aManager, aStore, aProbe, {
            updateStatus: () => { statusUpdates++; },
            onApplyFailure: () => { applyFailures++; },
            commitState: async (expected, next) => {
                gateCommits++;
                if (gateCommits === 1) {
                    // A revision-only bookkeeping commit lands between the
                    // gate's read and its write — a connection-test result or
                    // the monitoring start's proxyReachable reset.
                    await aStore.saveState({ ...aStore.stored, lastTestTimestamp: 1234 });
                }
                return aStore.commitState(expected, next);
            }
        });

        const deliveryState: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://needs-auth.example:8080',
            requiresAuth: true,
            revision: 1
        };
        await aManager.absorbRemoteChange(
            { state: deliveryState, version: 1 },
            async state => {
                await aStore.saveState(state);
                return aStore.revision;
            },
            adopted => applyRemoteSyncState(deliveryState, context(adopted))
        );

        assert.strictEqual(aStore.stored.lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR,
            'the gate error is recorded despite the revision-only commit');
        assert.strictEqual(aStore.stored.lastTestTimestamp, 1234,
            'the other writer\'s field survived the refold');
        assert.strictEqual(aStore.stored.proxyReachable, false);
        assert.strictEqual(aStore.stored.autoProxyUrl, 'http://needs-auth.example:8080');
        assert.deepStrictEqual(aProbe.monitoring, ['start']);
        assert.strictEqual(statusUpdates, 1);
        assert.strictEqual(applyFailures, 1);
        assert.deepStrictEqual(aProbe.applyCalls, []);
        assert.deepStrictEqual(aProbe.failures, []);
    });
});
