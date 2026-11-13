import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplyLockRequest, ApplyLockService } from '../../remediation/ApplyLockService';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Guards against the lock-steal race found in the v3 post-release review:
 * withLocks used a fixed TTL with no renewal, so a critical section that
 * legitimately outlives the TTL (slow git/npm diagnostics + delayed retries)
 * let a second window reclaim the lock as stale and write the same targets
 * concurrently. withLocks must keep the lease alive while the task runs.
 */
suite('ApplyLockService lease renewal', () => {
    let baseDir: string;

    setup(async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-test-'));
    });

    teardown(async () => {
        await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const target: ApplyLockRequest = {
        targetId: 'git.global.http.proxy',
        targetHost: 'workspaceHost',
        scope: 'hostUser'
    };

    test('a task running longer than the TTL keeps holding the lock (no steal)', async function () {
        this.timeout(10000);
        const holder = new ApplyLockService({ baseDir });
        const competitor = new ApplyLockService({ baseDir });
        const ttlMs = 300;

        let stealResult: Awaited<ReturnType<ApplyLockService['tryAcquire']>> | undefined;
        const result = await holder.withLocks([target], ttlMs, async () => {
            // Sleep well past the TTL, then let the competitor try to acquire.
            await sleep(ttlMs * 3);
            stealResult = await competitor.tryAcquire(target, ttlMs);
            return 'task-done';
        });

        assert.ok(result.acquired, 'holder must acquire the lock');
        assert.strictEqual(result.acquired && result.value, 'task-done');
        assert.ok(stealResult, 'competitor attempt must have run');
        assert.strictEqual(
            stealResult?.acquired,
            false,
            'competitor must NOT steal the lock while the task is still running'
        );
        assert.strictEqual(stealResult?.reason, 'held');
    });

    test('the lock is released after the long task finishes', async function () {
        this.timeout(10000);
        const holder = new ApplyLockService({ baseDir });
        const competitor = new ApplyLockService({ baseDir });
        const ttlMs = 300;

        await holder.withLocks([target], ttlMs, async () => {
            await sleep(ttlMs * 2);
            return undefined;
        });

        const afterRelease = await competitor.tryAcquire(target, ttlMs);
        assert.strictEqual(afterRelease.acquired, true, 'lock must be free after withLocks returns');
    });

    test('an unreadable lock during renewal is conservatively treated as held', async () => {
        const holder = new ApplyLockService({ baseDir });
        const competitor = new ApplyLockService({ baseDir });
        const acquired = await holder.tryAcquire(target, 300);
        assert.ok(acquired.acquired && acquired.handle, 'holder must acquire the lock');

        // Models the brief invalid JSON window created by an in-place lease
        // renewal write. A competitor must never classify that live path as a
        // reusable or failed lock.
        await fs.writeFile(acquired.handle.path, '{', 'utf8');
        const observed = await competitor.tryAcquire(target, 300);

        assert.strictEqual(observed.acquired, false);
        assert.strictEqual(observed.reason, 'held');
    });

    test('an in-flight renew must not recreate the lock after release (#137)', async function () {
        this.timeout(10000);
        let restoreWrite: (() => void) | null = null;
        try {
            const holder = new ApplyLockService({ baseDir });
            const acquired = await holder.tryAcquire(target, 5000);
            assert.ok(acquired.acquired && acquired.handle, 'holder must acquire the lock');
            const handle = acquired.handle;

            // Hold the renew's write open so the release lands while the renew
            // is between its read and its write — the window in which the
            // write used to resurrect the deleted lock. Patch the real
            // fs/promises object: every `import * as fs` wrapper forwards
            // through getters, so this intercepts the service's calls too
            // (sinon cannot stub the getter-only wrapper namespace).
            const fsp = require('fs/promises') as { writeFile: (p: unknown, data: unknown) => Promise<unknown> };
            const realWriteFile = fsp.writeFile;
            let writeEntered!: () => void;
            let releaseWrite!: () => void;
            const entered = new Promise<void>(resolve => { writeEntered = resolve; });
            const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
            let gateUsed = false;
            fsp.writeFile = async (p: unknown, data: unknown): Promise<unknown> => {
                if (!gateUsed && String(p).endsWith('.lock.json')) {
                    gateUsed = true;
                    writeEntered();
                    await gate;
                }
                return realWriteFile(p, data);
            };
            restoreWrite = () => { fsp.writeFile = realWriteFile; };

            const renewResult = holder.renew(handle, 5000);
            await entered;
            const releaseResult = holder.release(handle);
            // Give release's read+unlink a bounded window to land while the
            // write is still held: on unfixed code the unlink completes first
            // and the released write resurrects the lock. A correct
            // implementation serializes release behind the in-flight renew,
            // so this wait simply elapses there.
            await Promise.race([releaseResult.then(() => undefined), sleep(150)]);
            releaseWrite();

            assert.strictEqual(await renewResult, true, 'the in-flight renew itself still completes');
            await releaseResult;

            const leaked = await fs.readdir(baseDir).then(names => names.filter(n => n.endsWith('.lock.json')));
            assert.deepStrictEqual(leaked, [], 'release must leave no lock file a renew can resurrect');

            const peer = await new ApplyLockService({ baseDir }).tryAcquire(target, 300);
            assert.strictEqual(peer.acquired, true, 'a peer must be able to acquire after release');
        } finally {
            restoreWrite?.();
        }
    });

    test('renew on a released handle returns false and writes nothing (#137)', async () => {
        const holder = new ApplyLockService({ baseDir });
        const acquired = await holder.tryAcquire(target, 5000);
        assert.ok(acquired.acquired && acquired.handle, 'holder must acquire the lock');
        const handle = acquired.handle;

        assert.strictEqual(await holder.release(handle), true);
        assert.strictEqual(await holder.renew(handle, 5000), false, 'a released handle must not renew');

        const leaked = await fs.readdir(baseDir).then(names => names.filter(n => n.endsWith('.lock.json')));
        assert.deepStrictEqual(leaked, [], 'no lock file may exist after release');
    });
});
