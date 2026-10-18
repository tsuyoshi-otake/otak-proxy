import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProxyMode, ProxyState, stateRevision } from '../../core/types';
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
            commitState: async (expectedRevision, next) => {
                if (stateRevision(state) !== expectedRevision) {
                    return { kind: 'superseded', current: { ...state } };
                }
                state = { ...next, revision: expectedRevision + 1 };
                return { kind: 'committed', revision: expectedRevision + 1, state: { ...state } };
            },
            getActiveProxyUrl: current => current.autoProxyUrl || '',
            applyProxy: async () => true,
            startMonitoring: async () => undefined,
            stopMonitoring: async () => undefined,
            updateStatus: () => undefined
        });

        assert.strictEqual(applied, false);
        assert.strictEqual(state.autoProxyUrl, 'http://pending.example:8080');
    });

    // #108: the cross-window revision drop this test used to assert is gone —
    // per-window revisions are unrelated numbers. The equivalent protection
    // is the shared-file version watermark in SyncManager.absorbRemoteChange:
    // a delivery whose version is not above the highest version this window
    // published or adopted is skipped without saving or applying.
    test('a delivery at or below the adopted version watermark is skipped entirely', async () => {
        const manager = createManager();
        await manager.start();

        let state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://current.example:8080',
            revision: 5
        };
        let saves = 0;
        let applies = 0;
        let monitoring = 0;
        const saveRemoteState = async (next: ProxyState) => {
            saves++;
            state = { ...next, revision: stateRevision(state) + 1 };
            return stateRevision(state);
        };
        const absorbFor = (remote: ProxyState) =>
            (adopted: () => Promise<boolean>) =>
                applyRemoteSyncState(remote, {
                    saveState: async next => { state = { ...next }; },
                    getState: async () => ({ ...state }),
                    commitState: async (expectedRevision, next) => {
                        if (stateRevision(state) !== expectedRevision) {
                            return { kind: 'superseded', current: { ...state } };
                        }
                        state = { ...next, revision: expectedRevision + 1 };
                        return { kind: 'committed', revision: expectedRevision + 1, state: { ...state } };
                    },
                    getActiveProxyUrl: () => '',
                    applyProxy: async () => { applies++; return true; },
                    startMonitoring: async () => { monitoring++; },
                    stopMonitoring: async () => { monitoring++; },
                    updateStatus: () => undefined,
                    onApplyFailure: () => { applies++; },
                    adoptRemoteState: adopted
                });

        // Adopt one remote state at version 1 through the production owner.
        const adopted = { mode: ProxyMode.Auto, autoProxyUrl: 'http://other.example:8080' };
        await manager.absorbRemoteChange(
            { state: adopted, version: 1 },
            saveRemoteState,
            absorbFor(adopted)
        );
        assert.strictEqual(saves, 1);
        assert.strictEqual(applies, 1);

        // A delivery carrying the same shared version is superseded: nothing
        // is saved, applied, or monitored.
        const superseded = { mode: ProxyMode.Off, revision: 2 };
        await manager.absorbRemoteChange(
            { state: superseded, version: 1 },
            saveRemoteState,
            absorbFor(superseded)
        );

        assert.strictEqual(saves, 1);
        assert.strictEqual(applies, 1);
        assert.strictEqual(monitoring, 1);
        assert.strictEqual(state.autoProxyUrl, 'http://other.example:8080');
        await manager.stop();
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
