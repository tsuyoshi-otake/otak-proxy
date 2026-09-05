import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProxyMode, ProxyState } from '../../core/types';
import { applyRemoteSyncState } from '../../sync/RemoteSyncStateApplier';
import { ConflictResolver } from '../../sync/ConflictResolver';
import { SharedStateFile } from '../../sync/SharedStateFile';
import { SyncManager } from '../../sync/SyncManager';
import { sanitizeProxyStateForPersistence } from '../../utils/ProxyStateSanitizer';

suite('Stale sync publication (#17 P1-6)', () => {
    let testDir: string;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-sync-17-'));
    });

    teardown(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    function createManager(): SyncManager {
        return new SyncManager(testDir, 'window-test', {
            isSyncEnabled: () => true,
            getSyncInterval: () => 60_000,
            onConfigChange: () => ({ dispose: () => undefined }),
            dispose: () => undefined
        } as never, 'test');
    }

    test('a late notifyChange for revision N does not overwrite N+1 on disk', async () => {
        const manager = createManager();
        await manager.start();

        const generationN: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://n.example:8080',
            revision: 1
        };
        const generationN1: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://n-plus-1.example:8080',
            revision: 2
        };

        await manager.notifyChange(generationN);
        await manager.notifyChange(generationN1);
        await manager.notifyChange(generationN);

        const onDisk = await new SharedStateFile(testDir).read();
        assert.strictEqual(onDisk?.proxyState.autoProxyUrl, 'http://n-plus-1.example:8080');
        assert.ok((onDisk?.version ?? 0) >= 2);
        await manager.stop();
    });

    test('clock rollback cannot revive a lower logical version', () => {
        const resolver = new ConflictResolver();
        const newer = {
            state: { mode: ProxyMode.Auto, autoProxyUrl: 'http://new.example:8080' },
            timestamp: 1_000,
            instanceId: 'b',
            version: 8
        };
        const rolledBack = {
            state: { mode: ProxyMode.Off },
            timestamp: 9_999_999,
            instanceId: 'a',
            version: 3
        };

        const result = resolver.resolve(newer, rolledBack);
        assert.strictEqual(result.winner, 'local');
        assert.strictEqual(result.resolvedState.state.mode, ProxyMode.Auto);
    });

    test('equal timestamps do not last-write-win against a higher version', () => {
        const resolver = new ConflictResolver();
        const result = resolver.resolve(
            { state: { mode: ProxyMode.Off }, timestamp: 50, instanceId: 'a', version: 4 },
            { state: { mode: ProxyMode.Auto }, timestamp: 50, instanceId: 'b', version: 2 }
        );
        assert.strictEqual(result.winner, 'local');
    });

    test('remote convergencePending is not reported as a successful apply', async () => {
        let state: ProxyState = { mode: ProxyMode.Off, revision: 1 };
        const applied = await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://pending.example:8080',
            revision: 2,
            convergencePending: true
        }, {
            saveState: async next => { state = { ...next }; },
            getState: async () => ({ ...state }),
            getActiveProxyUrl: current => current.autoProxyUrl || '',
            applyProxy: async () => true,
            startMonitoring: async () => undefined,
            stopMonitoring: async () => undefined,
            updateStatus: () => undefined
        });

        assert.strictEqual(applied, false);
        assert.strictEqual(state.autoProxyUrl, 'http://pending.example:8080');
    });

    test('a stale remote snapshot with a lower revision does not roll local state back', async () => {
        let state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://current.example:8080',
            revision: 5
        };

        const applied = await applyRemoteSyncState({
            mode: ProxyMode.Off,
            revision: 2
        }, {
            saveState: async next => { state = { ...next }; },
            getState: async () => ({ ...state }),
            getActiveProxyUrl: () => '',
            applyProxy: async () => true,
            startMonitoring: async () => undefined,
            stopMonitoring: async () => undefined,
            updateStatus: () => undefined
        });

        assert.strictEqual(applied, false);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://current.example:8080');
    });

    test('shared persistence never writes proxy passwords', async () => {
        const file = new SharedStateFile(testDir);
        await file.write({
            version: 1,
            lastModified: 1,
            lastModifiedBy: 't',
            proxyState: sanitizeProxyStateForPersistence({
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://user:secret@proxy.example:8080',
                revision: 3
            })
        });

        const raw = fs.readFileSync(path.join(testDir, 'otak-proxy-sync', 'sync-state.json'), 'utf8');
        assert.ok(!raw.includes('secret'));
        const parsed = JSON.parse(raw);
        assert.strictEqual(parsed.proxyState.revision, 3);
    });
});
