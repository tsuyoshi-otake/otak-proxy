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

    test('a requiresAuth flip to true during the apply re-runs with the latest state', async () => {
        const initial: ProxyState = { revision: 1, mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' };
        const h = harness(initial);
        let pass = 0;

        const target = await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                if (pass === 0) {
                    // Credential metadata arrived mid-apply (e.g. a synced
                    // state): the skip path reads requiresAuth, so this is a
                    // real input change, not bookkeeping.
                    h.write(current => ({ ...current, requiresAuth: true }));
                }
                pass++;
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 2, 'a requiresAuth change reconciles once more');
        assert.strictEqual(h.appliedTargets[1].requiresAuth, true, 'the second apply sees the latest state');
        assert.strictEqual(target?.requiresAuth, true);
    });

    test('a requiresAuth flip to false during the apply re-runs with the latest state', async () => {
        const initial: ProxyState = {
            revision: 1,
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080',
            requiresAuth: true
        };
        const h = harness(initial);
        let pass = 0;

        const target = await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                if (pass === 0) {
                    h.write(current => {
                        const next = { ...current };
                        delete next.requiresAuth;
                        return next;
                    });
                }
                pass++;
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 2, 'a requiresAuth change reconciles once more');
        assert.strictEqual(h.appliedTargets[1].requiresAuth, undefined);
        assert.strictEqual(target?.requiresAuth, undefined);
    });

    test('a second pass runs when only authRequiredProxyUrls changes during the apply (#108)', async () => {
        const initial: ProxyState = { revision: 1, mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' };
        const h = harness(initial);
        let pass = 0;

        await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                if (pass === 0) {
                    // The per-address credential list arrived mid-apply (for
                    // example a synced state); the unauthenticated-apply gate
                    // reads it, so this is a real input change.
                    h.write(current => ({ ...current, authRequiredProxyUrls: ['http://a.example:8080/'] }));
                }
                pass++;
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 2, 'an authRequiredProxyUrls change reconciles once more');
        assert.deepStrictEqual(h.appliedTargets[1].authRequiredProxyUrls, ['http://a.example:8080/']);
    });

    test('a second pass runs when only a split URL changes during the apply (#108)', async () => {
        const initial: ProxyState = {
            revision: 1,
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080',
            autoProxyKind: 'perSchemeProxy',
            autoHttpProxyUrl: 'http://a.example:8080',
            autoHttpsProxyUrl: 'http://b.example:8443'
        };
        const h = harness(initial);
        let pass = 0;

        const target = await reconcileStartupProxyApply(
            initial,
            activeUrl,
            async t => {
                await h.apply(t);
                if (pass === 0) {
                    // The HTTPS URL's credentials were restored mid-apply;
                    // the write plan reads the split fields, so the gate and
                    // the plan must see the latest state.
                    h.write(current => ({ ...current, autoHttpsProxyUrl: 'http://user:pw@b.example:8443' }));
                }
                pass++;
            },
            h.getState,
            () => true
        );

        assert.strictEqual(h.appliedTargets.length, 2, 'a split-field change reconciles once more');
        assert.strictEqual(h.appliedTargets[1].autoHttpsProxyUrl, 'http://user:pw@b.example:8443');
        assert.strictEqual(target?.autoHttpsProxyUrl, 'http://user:pw@b.example:8443');
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
