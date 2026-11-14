import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProxyMode } from '../../core/types';
import { SyncManager } from '../../sync/SyncManager';
import { RemoteSyncDelivery } from '../../sync/SyncReconciler';

/**
 * #137 item 1: enabling `syncEnabled` while the extension keeps running must
 * adopt the shared state other windows already published, the same way
 * startup does. Before the fix the runtime `start()` loaded the shared file
 * into `currentState` but never delivered it, so this window's next local
 * publication overwrote the other windows' shared state with its own.
 */
suite('Runtime enable adopts the shared state (#137)', function() {
    this.timeout(20000);

    let testDir: string;
    let managers: SyncManager[];

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-reenable-'));
        managers = [];
    });

    teardown(async () => {
        for (const manager of managers) {
            await manager.stop();
        }
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    function mockConfig(enabled: boolean) {
        const listeners = new Set<(key: string, value: unknown) => void>();
        return {
            enabled,
            isSyncEnabled() { return this.enabled; },
            // Long interval: deliveries in this test come from the enable, not the poll.
            getSyncInterval: () => 3_600_000,
            onConfigChange(listener: (key: string, value: unknown) => void) {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: () => undefined,
            set(value: boolean) {
                this.enabled = value;
                for (const listener of listeners) {
                    listener('syncEnabled', value);
                }
            }
        };
    }

    async function waitFor(condition: () => boolean, what: string, ms = 8_000): Promise<void> {
        const start = Date.now();
        while (!condition()) {
            if (Date.now() - start > ms) {
                throw new Error(`timed out waiting for: ${what}`);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    test('enabling sync at runtime delivers the shared state another window published', async () => {
        // Window B: sync on, user toggled Off — the shared file carries v1:off.
        const bManager = new SyncManager(testDir, 'window-b', mockConfig(true) as never, 'test');
        managers.push(bManager);
        await bManager.start();
        await bManager.notifyChange({ mode: ProxyMode.Off, revision: 7 });
        const sharedPath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
        const onDisk = JSON.parse(fs.readFileSync(sharedPath, 'utf8')) as { version: number; proxyState: { mode: string } };
        assert.strictEqual(onDisk.version, 1);
        assert.strictEqual(onDisk.proxyState.mode, ProxyMode.Off);

        // Window A: already running with sync disabled (standalone mode).
        const cfgA = mockConfig(false);
        const aManager = new SyncManager(testDir, 'window-a', cfgA as never, 'test');
        managers.push(aManager);
        const deliveries: RemoteSyncDelivery[] = [];
        aManager.on('remoteChange', delivery => deliveries.push(delivery));
        await aManager.start();
        assert.strictEqual(aManager.isEnabled(), false, 'sync disabled: standalone mode');

        // The user enables sync at runtime.
        cfgA.set(true);
        await waitFor(() => aManager.isEnabled(), 'A to finish starting with sync on');

        await waitFor(() => deliveries.length >= 1, 'the shared Off state to be delivered to A');
        assert.strictEqual(deliveries[0].version, 1);
        assert.strictEqual(deliveries[0].state.mode, ProxyMode.Off);
        assert.strictEqual(aManager.getCurrentSharedState()?.mode, ProxyMode.Off);
    });

    test('a failed runtime-enable delivery is re-emitted by the next reconcile (#137)', async () => {
        // loadInitialState caches the shared file before the enable delivery
        // is emitted; when that delivery's save fails, the cache must not
        // keep claiming the window is synced or no reconcile ever re-emits.
        const bManager = new SyncManager(testDir, 'window-b', mockConfig(true) as never, 'test');
        managers.push(bManager);
        await bManager.start();
        await bManager.notifyChange({ mode: ProxyMode.Off, revision: 7 });

        const cfgA = mockConfig(false);
        const aManager = new SyncManager(testDir, 'window-a', cfgA as never, 'test');
        managers.push(aManager);
        const deliveries: RemoteSyncDelivery[] = [];
        const saved: string[] = [];
        let settled = 0;
        let failNextSave = true;
        aManager.on('remoteChange', delivery => {
            deliveries.push(delivery);
            void aManager.absorbRemoteChange(
                delivery,
                async () => {
                    if (failNextSave) {
                        failNextSave = false;
                        throw new Error('transient save failure');
                    }
                    saved.push(delivery.state.mode);
                    return 1;
                },
                adopted => adopted()
            ).catch(() => undefined).finally(() => { settled += 1; });
        });
        await aManager.start();

        cfgA.set(true);
        await waitFor(() => settled === 1, 'the failed enable delivery to settle');

        await aManager.triggerSync();
        await waitFor(() => saved.length === 1, 'the re-emitted delivery to be adopted');
        assert.strictEqual(deliveries.length, 2, 'the failed delivery must be re-emitted');
        assert.strictEqual(deliveries[1].version, 1);
        assert.strictEqual(saved[0], ProxyMode.Off);
    });

    /**
     * #137 follow-up: `readLockFile` rethrows non-ENOENT read errors, so a
     * transient EBUSY (an AV scan holding `instances.lock`) used to make
     * `register()` return false — and `SyncManager.start()` treats that as
     * fatal, disabling sync for the whole session. The read is retried with
     * bounded backoff inside the registry; a still-unreadable registry makes
     * register skip its write and report success (the heartbeat re-adds the
     * entry), never wipe other windows' entries, never take sync down.
     */
    suite('transient registry reads do not disable sync', () => {
        const lockFilePath = () => path.join(testDir, 'otak-proxy-sync', 'instances.lock');

        function seedForeignEntry(): void {
            fs.mkdirSync(path.dirname(lockFilePath()), { recursive: true });
            fs.writeFileSync(lockFilePath(), JSON.stringify({
                schemaVersion: 1,
                instances: [{
                    id: 'foreign-instance',
                    pid: process.pid,
                    windowId: 'window-b',
                    registeredAt: 1,
                    lastHeartbeat: Date.now(),
                    extensionVersion: 'test'
                }]
            }), 'utf-8');
        }

        // Fail the next `failures` reads of the registry lock file. Patch the
        // real fs object: `import * as fs` wrappers forward through getters,
        // so this intercepts the store's calls too.
        function patchLockFileReads(failures: number): () => void {
            const fsm = require('fs') as { readFileSync: (p: unknown, ...rest: unknown[]) => unknown };
            const realReadFileSync = fsm.readFileSync;
            let remaining = failures;
            fsm.readFileSync = (p: unknown, ...rest: unknown[]): unknown => {
                if (remaining > 0 && String(p) === lockFilePath()) {
                    remaining--;
                    const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return realReadFileSync(p, ...rest);
            };
            return () => { fsm.readFileSync = realReadFileSync; };
        }

        function readWindowIds(): string[] {
            const onDisk = JSON.parse(fs.readFileSync(lockFilePath(), 'utf-8')) as {
                instances: Array<{ windowId: string }>;
            };
            return onDisk.instances.map(instance => instance.windowId);
        }

        test('a persistent registry read failure neither disables sync nor wipes entries', async () => {
            seedForeignEntry();
            const restore = patchLockFileReads(Number.MAX_SAFE_INTEGER);
            const aManager = new SyncManager(testDir, 'window-a', mockConfig(true) as never, 'test');
            managers.push(aManager);
            let started: boolean;
            try {
                started = await aManager.start();
            } finally {
                restore();
            }

            assert.strictEqual(started, true, 'a transient registry read failure must not disable sync');
            assert.strictEqual(aManager.isEnabled(), true, 'sync stays active');
            assert.deepStrictEqual(readWindowIds(), ['window-b'],
                'a failed read left the other window\'s entry untouched');
        });

        test('a first-read failure is retried and the entry is written', async () => {
            seedForeignEntry();
            const restore = patchLockFileReads(1);
            const aManager = new SyncManager(testDir, 'window-a', mockConfig(true) as never, 'test');
            managers.push(aManager);
            let started: boolean;
            try {
                started = await aManager.start();
            } finally {
                restore();
            }

            assert.strictEqual(started, true);
            assert.deepStrictEqual(readWindowIds().sort(), ['window-a', 'window-b'],
                'the retry wrote this window\'s entry alongside the other window\'s');
        });
    });
});
