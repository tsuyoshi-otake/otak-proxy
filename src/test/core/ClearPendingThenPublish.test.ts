/**
 * #135: clearPendingThenPublish ends an apply that started from a state saved
 * with convergencePending. A commit that only advances the revision (a
 * connection-test result, another apply's per-target results) must not make
 * it drop the clear and the publish; a logically different state that landed
 * meanwhile still wins.
 *
 * Ownership travels inside the state: the commit that lands the flag also
 * writes an opaque `convergencePendingToken`, and the clear only proceeds
 * while the stored token is the one its own commit wrote. A commit that
 * never lands writes no token, so a lost or abandoned pending commit can
 * never strand the flag.
 */
import * as assert from 'assert';
import { clearPendingThenPublish, commitDecidedPatch } from '../../core/ApplyConvergence';
import { StateWriter } from '../../core/GenerationFence';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { createRealStateManager } from '../realProxyStateManager';

suite('clearPendingThenPublish under the generation fences (#135)', () => {
    const lostProxy = 'http://p.example:8080';

    async function harness(seedToken?: string) {
        const { manager } = createRealStateManager();
        await manager.saveState({
            mode: ProxyMode.Off,
            autoProxyUrl: lostProxy,
            convergencePending: true,
            convergencePendingToken: seedToken
        });
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
            /**
             * A second apply's pending commit for the same logical state:
             * identity unchanged, flag and its own token re-asserted.
             */
            landSameIdentityPending: (token?: string) => change(current => ({
                ...current,
                lastTestTimestamp: Date.now(),
                convergencePending: true,
                convergencePendingToken: token
            })),
            /** A commit that only re-routes the same primary URL: bypass changed, URLs did not. */
            landOtherBypass: (token?: string) => change(current => ({
                ...current,
                detectedBypass: 'localhost;*.internal.example',
                convergencePending: true,
                convergencePendingToken: token
            })),
            run: (pendingToken?: string, desiredOverride?: ProxyState) => clearPendingThenPublish(
                { proxyStateManager: writer, publishProxyState: async state => { published.push({ ...state }); } },
                'toggle',
                desiredOverride ?? desired,
                pendingToken
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

    test('a pending flag another apply committed meanwhile is left to that apply\'s token', async () => {
        const h = await harness('owner-a');
        h.hooks.afterRead.push(() => h.landSameIdentityPending('owner-b'));

        await h.run('owner-a');

        const after = await h.read();
        assert.strictEqual(after.convergencePending, true, 'the flag belongs to the apply whose token wrote it');
        assert.strictEqual(after.convergencePendingToken, 'owner-b');
        assert.strictEqual(h.commits.length, 0, 'no commit may be issued over another apply\'s flag');
        assert.strictEqual(h.published.length, 0, 'a flag this apply does not own publishes nothing');

        // The owning apply's own clear still ends its apply: flag and token
        // leave together, converged state published.
        const owned = await h.read();
        await h.run('owner-b', owned);
        const cleared = await h.read();
        assert.strictEqual(cleared.convergencePending, false, 'the owner clears its flag');
        assert.strictEqual(cleared.convergencePendingToken, undefined, 'the token leaves with the flag');
        assert.strictEqual(h.published.length, 1, 'the owning apply publishes its converged state');
        assert.strictEqual(h.published[0].convergencePendingToken, undefined);
    });

    test('a pending flag written with the caller\'s own token is cleared, token removed, and published', async () => {
        const h = await harness('owner-a');

        await h.run('owner-a');

        const after = await h.read();
        assert.strictEqual(after.convergencePending, false, 'the owner clears its flag');
        assert.strictEqual(after.convergencePendingToken, undefined, 'the token leaves with the flag');
        assert.strictEqual(h.published.length, 1, 'the converged state is published once');
        assert.strictEqual(h.published[0].convergencePendingToken, undefined, 'nothing published carries a token');
    });

    test('a flag carrying another apply\'s token is not released by a tokenless clear', async () => {
        const h = await harness('owner-b');

        await h.run();

        const after = await h.read();
        assert.strictEqual(after.convergencePending, true, 'a tokened flag answers only to its token');
        assert.strictEqual(after.convergencePendingToken, 'owner-b');
        assert.strictEqual(h.commits.length, 0);
        assert.deepStrictEqual(h.published, []);
    });

    test('a pending commit refolded and lost wrote no token: the earlier owner\'s clear still works', async () => {
        const h = await harness('owner-a');
        // A second apply's pending commit loses every compare-and-set; its
        // patch is refolded attempt after attempt and never lands, so the
        // token it would have written never entered the state (#135).
        let folds = 0;
        const losingWriter = {
            getState: () => h.read(),
            commitState: async (): Promise<StateCommitResult> =>
                ({ kind: 'superseded', current: await h.read() })
        };
        const outcome = await commitDecidedPatch(
            losingWriter,
            () => {
                folds++;
                return { convergencePending: true, convergencePendingToken: 'second-apply' };
            },
            () => true
        );
        assert.strictEqual(outcome.kind, 'exhausted');
        assert.strictEqual(folds, 3, 'the patch refolds on every lost attempt');

        const state = await h.read();
        assert.strictEqual(state.convergencePendingToken, 'owner-a', 'a commit that never lands writes no token');

        await h.run('owner-a');

        assert.strictEqual((await h.read()).convergencePending, false, 'the earlier owner\'s clear is unblocked');
        assert.strictEqual(h.published.length, 1);
    });

    test('a pending commit the guard rejects never wrote a token: the owner\'s clear is unaffected', async () => {
        const h = await harness('owner-a');
        // The second apply's fold decided flag+token, but the guard rejected
        // every latest state: nothing landed, nothing was claimed (#135).
        const losingWriter = {
            getState: () => h.read(),
            commitState: async (): Promise<StateCommitResult> =>
                ({ kind: 'superseded', current: await h.read() })
        };
        const moved = await commitDecidedPatch(
            losingWriter,
            () => ({ convergencePending: true, convergencePendingToken: 'second-apply' }),
            () => false
        );
        assert.strictEqual(moved.kind, 'moved');
        assert.strictEqual((await h.read()).convergencePendingToken, 'owner-a');

        await h.run('owner-a');

        assert.strictEqual((await h.read()).convergencePending, false);
        assert.strictEqual(h.published.length, 1);
    });

    test('a pending flag whose apply threw before its clear does not block the next apply', async () => {
        // The apply that wrote owner-a's flag crashed between its pending
        // commit and its clear. Nothing can release owner-a's token, but the
        // next apply's pending commit rewrites the flag under its own token
        // and its own clear releases that (#135).
        const h = await harness('owner-a');
        await h.landSameIdentityPending('owner-b');

        const owned = await h.read();
        await h.run('owner-b', owned);

        const after = await h.read();
        assert.strictEqual(after.convergencePending, false, 'the superseding apply\'s flag is released');
        assert.strictEqual(after.convergencePendingToken, undefined);
        assert.strictEqual(h.published.length, 1);
    });

    test('a pending flag left without a clear (an early-return path) yields to the next pending commit', async () => {
        // The connection-test early returns can leave flag+token behind with
        // no apply still running. The next apply's pending commit rewrites
        // the token; its own clear then releases the flag it owns (#135).
        const h = await harness('abandoned');
        await h.landSameIdentityPending('next-apply');

        const owned = await h.read();
        await h.run('next-apply', owned);

        const after = await h.read();
        assert.strictEqual(after.convergencePending, false);
        assert.strictEqual(after.convergencePendingToken, undefined);
        assert.strictEqual(h.published.length, 1);
    });

    test('a commit that only re-routes the same URL is a different generation: the flag is not cleared here', async () => {
        const h = await harness('owner-a');
        h.hooks.afterRead.push(() => h.landOtherBypass('other-apply'));

        await h.run('owner-a');

        const after = await h.read();
        assert.strictEqual(after.detectedBypass, 'localhost;*.internal.example');
        assert.strictEqual(after.convergencePending, true, 'a changed split routing is a different generation: its flag stays');
        assert.strictEqual(h.commits.length, 0, 'no commit may be issued over another writer\'s state');
        assert.deepStrictEqual(h.published, []);
    });
});
