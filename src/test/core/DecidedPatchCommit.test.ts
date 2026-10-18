/**
 * #78: the shared "commit a decided patch onto the latest state" helper.
 * The toggle and the initial setup both fold only the fields they decided
 * onto whatever another writer committed meanwhile, bounded by the same
 * compare-and-set policy.
 */
import * as assert from 'assert';
import { commitDecidedPatch, diffProxyState } from '../../core/ApplyConvergence';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';

suite('commitDecidedPatch folds a decided patch onto the latest state (#78)', () => {
    function harness(initial: ProxyState) {
        let stored = { ...initial };
        const writes: ProxyState[] = [];
        /** Runs inside the next commitState call, before the revision check. */
        const queuedCommitWrites: Array<() => void> = [];
        return {
            queuedCommitWrites,
            stored: () => stored,
            writes,
            writer: {
                getState: async () => ({ ...stored }),
                commitState: async (expected: number, next: ProxyState): Promise<StateCommitResult> => {
                    queuedCommitWrites.shift()?.();
                    if (stateRevision(stored) !== expected) {
                        return { kind: 'superseded', current: { ...stored } };
                    }
                    stored = { ...next, revision: expected + 1 };
                    writes.push({ ...stored });
                    return { kind: 'committed', revision: stored.revision!, state: { ...stored } };
                }
            },
            /** Another writer landing a commit: revision +1. */
            write: (change: (current: ProxyState) => ProxyState) => {
                stored = { ...change({ ...stored }), revision: stateRevision(stored) + 1 };
            }
        };
    }

    const alwaysValid = () => true;

    test('commits on the first try', async () => {
        const h = harness({ revision: 1, mode: ProxyMode.Off });

        const outcome = await commitDecidedPatch(
            h.writer,
            { mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' },
            alwaysValid
        );

        assert.strictEqual(outcome.kind, 'committed');
        assert.strictEqual(h.stored().mode, ProxyMode.Auto);
        assert.strictEqual(h.stored().autoProxyUrl, 'http://a.example:8080');
        assert.strictEqual(h.stored().revision, 2);
    });

    test('a revision-only conflict refolds onto the other writer\'s fields', async () => {
        const h = harness({ revision: 1, mode: ProxyMode.Off });
        h.queuedCommitWrites.push(() => {
            h.write(current => ({ ...current, lastTestTimestamp: 4242, lastError: 'boom' }));
        });

        const outcome = await commitDecidedPatch(
            h.writer,
            { mode: ProxyMode.Auto },
            alwaysValid
        );

        assert.strictEqual(outcome.kind, 'committed');
        // The patch landed and the interleaved write is still there.
        assert.strictEqual(h.stored().mode, ProxyMode.Auto);
        assert.strictEqual(h.stored().lastTestTimestamp, 4242);
        assert.strictEqual(h.stored().lastError, 'boom');
        assert.strictEqual(h.stored().revision, 3);
    });

    test('moved when the guard rejects; nothing is written', async () => {
        const h = harness({ revision: 1, mode: ProxyMode.Off });
        const commits: unknown[] = [];
        const writer = {
            getState: h.writer.getState,
            commitState: async (expected: number, next: ProxyState) => {
                commits.push(next);
                return h.writer.commitState(expected, next);
            }
        };

        const outcome = await commitDecidedPatch(
            writer,
            { mode: ProxyMode.Auto },
            latest => latest.mode === ProxyMode.Manual
        );

        assert.strictEqual(outcome.kind, 'moved');
        assert.strictEqual(outcome.kind === 'moved' && outcome.state.mode, ProxyMode.Off);
        assert.strictEqual(commits.length, 0, 'no commit attempt may be issued');
        assert.deepStrictEqual(h.stored(), { revision: 1, mode: ProxyMode.Off });
    });

    test('exhausted after three conflicts; nothing is written', async () => {
        const h = harness({ revision: 1, mode: ProxyMode.Off });
        // Every attempt loses the CAS race to a revision bump.
        for (let i = 0; i < 5; i++) {
            h.queuedCommitWrites.push(() => {
                h.write(current => ({ ...current, lastTestTimestamp: Date.now() }));
            });
        }

        const outcome = await commitDecidedPatch(h.writer, { mode: ProxyMode.Auto }, alwaysValid);

        assert.strictEqual(outcome.kind, 'exhausted');
        assert.strictEqual(h.stored().mode, ProxyMode.Off, 'the patch was never stored');
        assert.strictEqual(h.writes.length, 0);
    });

    test('a patch key set to undefined removes the field', async () => {
        const h = harness({ revision: 1, mode: ProxyMode.Off, requiresAuth: true });

        const outcome = await commitDecidedPatch(
            h.writer,
            { mode: ProxyMode.Auto, requiresAuth: undefined },
            alwaysValid
        );

        assert.strictEqual(outcome.kind, 'committed');
        assert.strictEqual('requiresAuth' in h.stored(), false, 'the key must be deleted, not stored as undefined');
        assert.strictEqual(h.stored().requiresAuth, undefined);
    });

    test('diffProxyState covers the union of keys, carrying deletions as undefined', () => {
        const before: ProxyState = {
            mode: ProxyMode.Off,
            requiresAuth: true,
            lastError: 'old',
            autoProxyUrl: 'http://same.example:1'
        };
        const after: ProxyState = {
            mode: ProxyMode.Auto,
            lastError: 'old',
            autoProxyUrl: 'http://same.example:1',
            autoModeOff: true
        };

        const patch = diffProxyState(before, after);

        assert.deepStrictEqual(patch, {
            mode: ProxyMode.Auto,
            requiresAuth: undefined,
            autoModeOff: true
        });
    });
});
