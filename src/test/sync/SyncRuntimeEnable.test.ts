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
});
