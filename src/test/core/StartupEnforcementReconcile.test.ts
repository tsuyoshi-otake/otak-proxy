/**
 * #78: the startup enforcement loop used to re-apply because its stability
 * signature included the revision, which its own apply's result commit always
 * moves. The signature must compare identity only.
 */
import * as assert from 'assert';
import { reconcileStartupProxyApply } from '../../core/StartupEnforcement';
import { ProxyMode, ProxyState, stateRevision } from '../../core/types';

suite('Startup proxy enforcement reconcile loop (#78)', () => {
    const activeUrl = (s: ProxyState) =>
        s.mode === ProxyMode.Auto && s.autoModeOff !== true ? s.autoProxyUrl ?? '' : '';

    function harness(initial: ProxyState) {
        let stored = { ...initial };
        const appliedTargets: ProxyState[] = [];
        return {
            appliedTargets,
            state: () => stored,
            getState: async () => ({ ...stored }),
            apply: async (target: ProxyState) => {
                appliedTargets.push({ ...target });
            },
            /** Simulate the apply's own result commit: revision +1, same identity. */
            commitResults: () => {
                stored = { ...stored, revision: stateRevision(stored) + 1 };
            },
            write: (change: (current: ProxyState) => ProxyState) => {
                stored = { ...change({ ...stored }), revision: stateRevision(stored) + 1 };
            }
        };
    }

    test('one apply when only its own result commit moves the revision', async () => {
        const initial: ProxyState = { revision: 1, mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' };
        const h = harness(initial);

        const target = await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                h.commitResults();
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 1, 'its own commit must not retrigger the apply');
        assert.strictEqual(target?.mode, ProxyMode.Auto);
    });

    test('a second pass runs when the identity changed during the apply', async () => {
        const initial: ProxyState = { revision: 1, mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' };
        const h = harness(initial);
        let pass = 0;

        const target = await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                if (pass === 0) {
                    // Another writer (a toggle) changed the mode mid-apply.
                    h.write(current => ({ ...current, mode: ProxyMode.Off }));
                }
                pass++;
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 2, 'a changed identity reconciles once more');
        assert.strictEqual(target?.mode, ProxyMode.Off);
    });

    test('the loop stays bounded when the identity keeps changing', async () => {
        const initial: ProxyState = { revision: 1, mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' };
        const h = harness(initial);
        let flip = false;

        await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                flip = !flip;
                h.write(current => ({ ...current, autoModeOff: flip }));
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 3, 'bounded at three attempts');
    });
});
