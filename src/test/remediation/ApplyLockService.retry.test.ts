import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplyLockRequest, ApplyLockService } from '../../remediation/ApplyLockService';

/**
 * Bounded lock wait (#30): instead of skipping the apply on the first
 * contended acquire, withLocks walks a fixed retry-delay schedule so a
 * window that loses the multi-window race waits out the winner's short
 * convergence and then applies normally. The schedule is injected together
 * with a sleep so tests stay deterministic and instant.
 */
suite('ApplyLockService bounded retry schedule (#30)', () => {
    let baseDir: string;

    setup(async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-retry-test-'));
    });

    teardown(async () => {
        await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const gitTarget: ApplyLockRequest = {
        targetId: 'git.global.http.proxy',
        targetHost: 'workspaceHost',
        scope: 'hostUser'
    };

    test('retries per the fixed schedule and acquires once the holder releases', async () => {
        const holder = new ApplyLockService({ baseDir });
        const waiter = new ApplyLockService({ baseDir });
        const held = await holder.tryAcquire(gitTarget, 30000);
        assert.ok(held.acquired && held.handle);

        const delays: number[] = [];
        const result = await waiter.withLocks([gitTarget], 30000, async () => 'ran', {
            retryDelaysMs: [10, 20, 30],
            sleep: async ms => {
                delays.push(ms);
                if (delays.length === 2 && held.handle) {
                    await holder.release(held.handle);
                }
            }
        });

        assert.ok(result.acquired, 'the waiter must acquire after the holder releases mid-schedule');
        assert.strictEqual(result.acquired && result.value, 'ran');
        assert.deepStrictEqual(delays, [10, 20], 'remaining schedule entries must not be consumed');
    });

    test('gives up with reason held after exhausting the schedule', async () => {
        const holder = new ApplyLockService({ baseDir });
        const waiter = new ApplyLockService({ baseDir });
        const held = await holder.tryAcquire(gitTarget, 30000);
        assert.ok(held.acquired && held.handle);

        const delays: number[] = [];
        try {
            const result = await waiter.withLocks([gitTarget], 30000, async () => 'ran', {
                retryDelaysMs: [5, 5],
                sleep: async ms => {
                    delays.push(ms);
                }
            });

            assert.strictEqual(result.acquired, false);
            assert.strictEqual(!result.acquired && result.failed.reason, 'held');
            assert.deepStrictEqual(delays, [5, 5], 'every schedule slot must be tried before giving up');
        } finally {
            if (held.handle) {
                await holder.release(held.handle);
            }
        }
    });

    test('no schedule keeps the historical single-attempt behavior', async () => {
        const holder = new ApplyLockService({ baseDir });
        const waiter = new ApplyLockService({ baseDir });
        const held = await holder.tryAcquire(gitTarget, 30000);
        assert.ok(held.acquired && held.handle);

        let attempts = 0;
        const originalTryAcquire = waiter.tryAcquire.bind(waiter);
        (waiter as unknown as { tryAcquire: typeof waiter.tryAcquire }).tryAcquire = async (target, ttlMs) => {
            attempts += 1;
            return originalTryAcquire(target, ttlMs);
        };

        try {
            const result = await waiter.withLocks([gitTarget], 30000, async () => 'ran');

            assert.strictEqual(result.acquired, false);
            assert.strictEqual(attempts, 1, 'without a schedule there must be exactly one acquire attempt');
        } finally {
            if (held.handle) {
                await holder.release(held.handle);
            }
        }
    });
});
