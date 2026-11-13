/**
 * #135: clearPendingThenPublish ends an apply that started from a state saved
 * with convergencePending. A commit that only advances the revision (a
 * connection-test result, another apply's per-target results) must not make
 * it drop the clear and the publish; a logically different state that landed
 * meanwhile still wins.
 */
import * as assert from 'assert';
import { clearPendingThenPublish } from '../../core/ApplyConvergence';
import { StateWriter } from '../../core/GenerationFence';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { createRealStateManager } from '../realProxyStateManager';

suite('clearPendingThenPublish under the generation fences (#135)', () => {
    const lostProxy = 'http://p.example:8080';

    async function harness() {
        const { manager } = createRealStateManager();
        await manager.saveState({ mode: ProxyMode.Off, autoProxyUrl: lostProxy, convergencePending: true });
        const desired = await manager.getState();
        const published: ProxyState[] = [];
        const commits: ProxyState[] = [];
        const hooks = {
            /** Runs right after the next read, which still returns the state it read. */
            afterRead: [] as Array<() => Promise<void>>,
            /** Runs inside the next commit, before its revision check. */
            beforeCommit: [] as Array<() => Promise<void>>,
            /** Runs after the next commit settled. */
            afterCommit: [] as Array<() => Promise<void>>
        };
        const writer: StateWriter = {
            getState: async () => {
                const read = await manager.getState();
                await hooks.afterRead.shift()?.();
                return read;
            },
            saveState: state => manager.saveState(state),
            commitState: async (expected: number, next: ProxyState): Promise<StateCommitResult> => {
                commits.push(next);
                await hooks.beforeCommit.shift()?.();
                const result = await manager.commitState(expected, next);
                await hooks.afterCommit.shift()?.();
                return result;
            }
        };

        async function change(update: (current: ProxyState) => ProxyState): Promise<void> {
            const current = await manager.getState();
            const result = await manager.commitState(stateRevision(current), update({ ...current }));
            assert.strictEqual(result.kind, 'committed', 'the other writer must land its commit');
        }

        return {
            desired,
            hooks,
            published,
            commits,
            read: () => manager.getState(),
            /** A commit another apply or a connection test makes: the revision moves, the logical state does not. */
            landRevisionOnly: () => change(current => ({
                ...current,
                lastError: undefined,
                gitConfigured: false,
                lastTestTimestamp: Date.now()
            })),
            /** A commit that changes what the state means: a toggle, a newer detection. */
            landOtherState: () => change(current => ({
                ...current,
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://other.example:9090',
                convergencePending: true
            })),
            run: () => clearPendingThenPublish(
                { proxyStateManager: writer, publishProxyState: async state => { published.push({ ...state }); } },
                'toggle',
                desired
            )
        };
    }

    test('a revision-only commit landing after the identity read still clears the flag and publishes', async () => {
        const h = await harness();
        h.hooks.afterRead.push(h.landRevisionOnly);

        await h.run();

        const after = await h.read();
        assert.strictEqual(after.convergencePending, false, 'the pending flag must be cleared');
        assert.strictEqual(after.gitConfigured, false, 'the other writer\'s bookkeeping is kept');
        assert.strictEqual(h.published.length, 1, 'the converged state is published once');
        assert.strictEqual(h.published[0].convergencePending, false);
        assert.strictEqual(h.published[0].mode, ProxyMode.Off);
    });

    test('a revision-only commit that wins the compare-and-set race still clears the flag and publishes', async () => {
        const h = await harness();
        h.hooks.beforeCommit.push(h.landRevisionOnly);

        await h.run();

        assert.strictEqual((await h.read()).convergencePending, false);
        assert.strictEqual(h.published.length, 1);
        assert.strictEqual(h.published[0].convergencePending, false);
    });

    test('revision-only commits that keep winning end the call after a bounded number of attempts, flag and publish untouched', async () => {
        const h = await harness();
        for (let i = 0; i < 20; i++) {
            h.hooks.beforeCommit.push(h.landRevisionOnly);
        }

        await h.run();

        const after = await h.read();
        assert.ok(h.commits.length >= 1 && h.commits.length <= 3, `bounded attempts, got ${h.commits.length}`);
        assert.strictEqual(after.convergencePending, true, 'never cleared: no attempt won');
        assert.deepStrictEqual(h.published, [], 'a still-pending state is not published as converged');
    });

    test('a logically different state landing before the clear wins: its flag stays and nothing is published', async () => {
        const h = await harness();
        h.hooks.afterRead.push(h.landOtherState);

        await h.run();

        const after = await h.read();
        assert.strictEqual(after.mode, ProxyMode.Auto);
        assert.strictEqual(after.autoProxyUrl, 'http://other.example:9090');
        assert.strictEqual(after.convergencePending, true, 'the flag belongs to the writer that moved the state');
        assert.strictEqual(h.commits.length, 0, 'no commit may be issued over another writer\'s state');
        assert.deepStrictEqual(h.published, []);
    });

    test('a logically different state landing between the clear and the publish is not published by this call', async () => {
        const h = await harness();
        h.hooks.afterCommit.push(h.landOtherState);

        await h.run();

        const after = await h.read();
        assert.strictEqual(after.mode, ProxyMode.Auto);
        assert.strictEqual(after.convergencePending, true);
        assert.deepStrictEqual(h.published, [], 'its owner publishes it once it converged');
    });
});
