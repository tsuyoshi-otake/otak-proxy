/**
 * Compare-and-swap contention tests for SharedStateFile (#73).
 *
 * `compareAndSwap()` is the only thing standing between two VS Code windows
 * and a lost update: `SyncManager.notifyChange()` treats `'written'` as proof
 * that its own snapshot is the published one. These tests drive two publishers
 * that read the same on-disk version and then race to write.
 *
 * The interleaving is deterministic, not timing-dependent: both calls suspend
 * at their first `await` before either reaches its write, which is exactly the
 * cross-process ordering the file lock has to rule out.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SharedState, SharedStateFile } from '../../sync/SharedStateFile';
import { ProxyMode } from '../../core/types';

function stateAt(version: number, instanceId: string, proxyUrl: string): SharedState {
    return {
        version,
        lastModified: Date.now(),
        lastModifiedBy: instanceId,
        proxyState: { mode: ProxyMode.Manual, manualProxyUrl: proxyUrl }
    };
}

suite('SharedStateFile compare-and-swap contention (#73)', () => {
    let testDir: string;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-cas-'));
    });

    teardown(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    test('two publishers that read the same version must not both win', async () => {
        const windowA = new SharedStateFile(testDir);
        const windowB = new SharedStateFile(testDir);

        await windowA.write(stateAt(10, 'seed', 'http://seed.example:8080'));

        const [resultA, resultB] = await Promise.all([
            windowA.compareAndSwap(10, stateAt(11, 'window-a', 'http://a.example:8080')),
            windowB.compareAndSwap(10, stateAt(11, 'window-b', 'http://b.example:8080'))
        ]);

        assert.deepStrictEqual(
            [resultA, resultB].sort(),
            ['stale', 'written'],
            'exactly one publisher may observe its CAS as written'
        );
    });

    test('the publisher told "written" is the one whose state survives on disk', async () => {
        const windowA = new SharedStateFile(testDir);
        const windowB = new SharedStateFile(testDir);

        await windowA.write(stateAt(10, 'seed', 'http://seed.example:8080'));

        const [resultA, resultB] = await Promise.all([
            windowA.compareAndSwap(10, stateAt(11, 'window-a', 'http://a.example:8080')),
            windowB.compareAndSwap(10, stateAt(11, 'window-b', 'http://b.example:8080'))
        ]);

        const winner = resultA === 'written' ? 'window-a' : 'window-b';
        assert.notStrictEqual(resultA, resultB, 'the two publishers must not agree on the outcome');

        const onDisk = await windowA.read();
        assert.ok(onDisk, 'state file must still be readable after contention');
        assert.strictEqual(
            onDisk!.lastModifiedBy,
            winner,
            'the surviving state must belong to the publisher that was told "written"'
        );
    });

    test('a first publish races on absence, not on a version', async () => {
        const windowA = new SharedStateFile(testDir);
        const windowB = new SharedStateFile(testDir);

        const [resultA, resultB] = await Promise.all([
            windowA.compareAndSwap(undefined, stateAt(1, 'window-a', 'http://a.example:8080')),
            windowB.compareAndSwap(undefined, stateAt(1, 'window-b', 'http://b.example:8080'))
        ]);

        assert.deepStrictEqual(
            [resultA, resultB].sort(),
            ['stale', 'written'],
            'only one window may create the initial shared state'
        );
    });

    test('a losing publisher does not overwrite a newer version', async () => {
        const windowA = new SharedStateFile(testDir);
        const windowB = new SharedStateFile(testDir);

        await windowA.write(stateAt(10, 'seed', 'http://seed.example:8080'));
        await windowA.compareAndSwap(10, stateAt(11, 'window-a', 'http://a.example:8080'));

        const late = await windowB.compareAndSwap(10, stateAt(11, 'window-b', 'http://b.example:8080'));

        assert.strictEqual(late, 'stale');
        const onDisk = await windowA.read();
        assert.strictEqual(onDisk!.lastModifiedBy, 'window-a');
        assert.strictEqual(onDisk!.version, 11);
    });
});
