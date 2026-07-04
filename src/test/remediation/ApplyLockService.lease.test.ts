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
});
