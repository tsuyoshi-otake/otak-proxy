import * as assert from 'assert';
import { AppliedPlanTracker } from '../../core/AppliedPlanTracker';
import { ProxyApplyDetailedResult } from '../../core/ProxyApplierTypes';
import { ProxyState, ProxyMode, stateRevision } from '../../core/types';
import { runProxyApplyAttempt } from '../../remediation/ProxyApplyAttempt';
import { getCredentialKeyForPublicUrl } from '../../security/ProxyCredentialStore';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../../sync/RemoteSyncStateApplier';
import { createRealStateManager } from '../realProxyStateManager';

/**
 * Receiver dedupe for #108: a remote publication whose (enabled, active URL,
 * resolved plan) equals this window's last verifiably applied plan is
 * adopted but not re-applied. Priming goes through the real
 * runProxyApplyAttempt, so the record is written by production code.
 */
suite('Remote apply dedupe (#108)', function() {
    this.timeout(30000);

    function okApply(url: string, enabled: boolean): ProxyApplyDetailedResult {
        return {
            success: true,
            enabled,
            proxyUrl: url,
            results: { gitSuccess: true, vscodeSuccess: true, npmSuccess: true, terminalEnvSuccess: true },
            errors: []
        };
    }

    interface Receiver {
        context: RemoteSyncApplyContext;
        calls: Array<{ url: string; enabled: boolean }>;
        monitoring: string[];
        failures: number;
    }

    function makeReceiver(
        manager: ReturnType<typeof createRealStateManager>['manager'],
        tracker: AppliedPlanTracker
    ): Receiver {
        const receiver: Receiver = { context: undefined as never, calls: [], monitoring: [], failures: 0 };
        receiver.context = {
            saveState: state => manager.saveState(state),
            getState: () => manager.getState(),
            commitState: (expected, next) => manager.commitState(expected, next),
            getActiveProxyUrl: state => manager.getActiveProxyUrl(state),
            applyProxy: async (url, enabled) => {
                receiver.calls.push({ url, enabled });
                return true;
            },
            startMonitoring: async () => { receiver.monitoring.push('start'); },
            stopMonitoring: async () => { receiver.monitoring.push('stop'); },
            updateStatus: () => undefined,
            onApplyFailure: () => { receiver.failures++; },
            lastAppliedPlan: () => tracker.lastAppliedPlan(),
            isApplyInFlight: () => tracker.isApplyInFlight()
        };
        return receiver;
    }

    async function primeAttempt(
        manager: ReturnType<typeof createRealStateManager>['manager'],
        tracker: AppliedPlanTracker,
        url: string,
        enabled: boolean
    ): Promise<void> {
        const result = await runProxyApplyAttempt(
            manager,
            async (u, e) => okApply(u, e),
            undefined,
            url,
            enabled,
            'sync',
            undefined,
            tracker
        );
        assert.strictEqual(result.success, true, 'priming attempt must succeed');
    }

    test('a publication differing only in test fields is adopted without an apply', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        await harness.manager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://p.example:8080' });
        await primeAttempt(harness.manager, tracker, 'http://p.example:8080', true);
        const receiver = makeReceiver(harness.manager, tracker);

        const applied = await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://p.example:8080',
            proxyReachable: true,
            lastTestTimestamp: 123,
            lastTestResult: {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://p.example:8080',
                timestamp: 123,
                duration: 10
            }
        }, receiver.context);

        assert.strictEqual(applied, true);
        assert.deepStrictEqual(receiver.calls, []);
        assert.deepStrictEqual(receiver.monitoring, ['start']);
        assert.strictEqual(receiver.failures, 0);
    });

    test('a changed primary URL applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        await harness.manager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://p.example:8080' });
        await primeAttempt(harness.manager, tracker, 'http://p.example:8080', true);
        const receiver = makeReceiver(harness.manager, tracker);

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://other.example:8080'
        }, receiver.context);

        assert.deepStrictEqual(receiver.calls, [{ url: 'http://other.example:8080', enabled: true }]);
    });

    test('an autoHttpsProxyUrl-only change of a per-scheme proxy applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        const perScheme: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://p.example:80',
            autoProxyKind: 'perSchemeProxy',
            autoHttpProxyUrl: 'http://p.example:80',
            autoHttpsProxyUrl: 'http://ps.example:443'
        };
        await harness.manager.saveState(perScheme);
        await primeAttempt(harness.manager, tracker, 'http://p.example:80', true);
        const receiver = makeReceiver(harness.manager, tracker);

        await applyRemoteSyncState({ ...perScheme, autoHttpsProxyUrl: 'http://ps2.example:443' }, receiver.context);

        assert.strictEqual(receiver.calls.length, 1);
    });

    test('a detectedBypass-only change applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        const base: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://p.example:80',
            autoProxyKind: 'perSchemeProxy',
            autoHttpProxyUrl: 'http://p.example:80',
            autoHttpsProxyUrl: 'http://ps.example:443',
            detectedBypass: 'localhost'
        };
        await harness.manager.saveState(base);
        await primeAttempt(harness.manager, tracker, 'http://p.example:80', true);
        const receiver = makeReceiver(harness.manager, tracker);

        await applyRemoteSyncState({ ...base, detectedBypass: 'localhost,*.internal' }, receiver.context);

        assert.strictEqual(receiver.calls.length, 1);
    });

    suite('a previous attempt that wrote nothing leaves no record', () => {
        for (const stopReason of ['lockSkipped', 'consentRequired', 'lockIoError'] as const) {
            test(`the last attempt was ${stopReason}`, async () => {
                const harness = createRealStateManager();
                const tracker = new AppliedPlanTracker();
                const receiver = makeReceiver(harness.manager, tracker);

                const refusedRemediation = {
                    applyWithSafety: async () => ({
                        success: false,
                        retryAttempted: false,
                        retrySuppressed: false,
                        lockSkipped: stopReason === 'lockSkipped',
                        lockIoError: stopReason === 'lockIoError',
                        outcome: { stopReason }
                    })
                };
                const result = await runProxyApplyAttempt(
                    harness.manager,
                    async (u, e) => okApply(u, e),
                    refusedRemediation as never,
                    'http://p.example:8080',
                    true,
                    'sync',
                    undefined,
                    tracker
                );
                assert.strictEqual(result.success, false);

                await applyRemoteSyncState({
                    mode: ProxyMode.Auto,
                    autoProxyUrl: 'http://p.example:8080'
                }, receiver.context);

                assert.strictEqual(receiver.calls.length, 1);
            });
        }

        test('the last attempt was refused by the credential gate', async () => {
            const harness = createRealStateManager();
            const tracker = new AppliedPlanTracker();
            const receiver = makeReceiver(harness.manager, tracker);

            // A fake writer whose state requires credentials the plan lacks:
            // the attempt is refused before any write.
            const stored = {
                state: {
                    mode: ProxyMode.Auto,
                    autoProxyUrl: 'http://p.example:8080',
                    authRequiredProxyUrls: ['http://p.example:8080/'],
                    requiresAuth: true,
                    revision: 1
                } as ProxyState
            };
            const refusedWriter = {
                getState: async (): Promise<ProxyState> => ({ ...stored.state }),
                saveState: async (next: ProxyState) => { stored.state = { ...next }; },
                commitState: async (expected: number, next: ProxyState) => {
                    if (stateRevision(stored.state) !== expected) {
                        return { kind: 'superseded', current: { ...stored.state } } as const;
                    }
                    stored.state = { ...next, revision: expected + 1 };
                    return { kind: 'committed', revision: expected + 1, state: { ...stored.state } } as const;
                }
            };
            const result = await runProxyApplyAttempt(
                refusedWriter,
                async (u, e) => okApply(u, e),
                undefined,
                'http://p.example:8080',
                true,
                'sync',
                undefined,
                tracker
            );
            assert.strictEqual(result.success, false);

            await applyRemoteSyncState({
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://p.example:8080'
            }, receiver.context);

            assert.strictEqual(receiver.calls.length, 1);
        });
    });

    test('a delivery arriving while an attempt is in flight applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        const receiver = makeReceiver(harness.manager, tracker);

        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const pending = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => { await gate; return okApply(u, e); },
            undefined,
            'http://p.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://p.example:8080'
        }, receiver.context);
        assert.strictEqual(receiver.calls.length, 1);

        release();
        await pending;
    });

    test('two overlapping successful attempts leave no record', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        const receiver = makeReceiver(harness.manager, tracker);

        let release1!: () => void;
        let release2!: () => void;
        const gate1 = new Promise<void>(resolve => { release1 = resolve; });
        const gate2 = new Promise<void>(resolve => { release2 = resolve; });
        const pending1 = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => { await gate1; return okApply(u, e); },
            undefined,
            'http://p.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );
        const pending2 = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => { await gate2; return okApply(u, e); },
            undefined,
            'http://p.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );

        release1();
        release2();
        await Promise.all([pending1, pending2]);

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://p.example:8080'
        }, receiver.context);
        assert.strictEqual(receiver.calls.length, 1);
    });

    test('a delivery while an earlier overlapping attempt still runs applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();
        const receiver = makeReceiver(harness.manager, tracker);

        let release1!: () => void;
        let release2!: () => void;
        const gate1 = new Promise<void>(resolve => { release1 = resolve; });
        const gate2 = new Promise<void>(resolve => { release2 = resolve; });
        // Attempts 1 and 2 overlap.
        const pending1 = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => { await gate1; return okApply(u, e); },
            undefined,
            'http://old.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );
        const pending2 = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => { await gate2; return okApply(u, e); },
            undefined,
            'http://second.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );
        // Attempt 1 finishes. Attempt 3 then starts and finishes while
        // attempt 2 is still running.
        release1();
        await pending1;
        const pending3 = runProxyApplyAttempt(
            harness.manager,
            async (u, e) => okApply(u, e),
            undefined,
            'http://third.example:8080',
            true,
            'sync',
            undefined,
            tracker
        );
        await pending3;

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://third.example:8080'
        }, receiver.context);
        assert.strictEqual(receiver.calls.length, 1);

        release2();
        await pending2;
    });

    test('a credential rotated in SecretStorage for the same address applies', async () => {
        const harness = createRealStateManager();
        const tracker = new AppliedPlanTracker();

        await harness.manager.saveState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://user:pass1@proxy.example:8080'
        });
        const hydratedBefore = await harness.manager.getState();
        await primeAttempt(harness.manager, tracker, hydratedBefore.autoProxyUrl!, true);
        const receiver = makeReceiver(harness.manager, tracker);

        // Rotate the stored credential for the same public address.
        const key = getCredentialKeyForPublicUrl('http://proxy.example:8080/');
        harness.secrets.set(key, JSON.stringify({ username: 'user', password: 'pass2' }));

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080'
        }, receiver.context);

        assert.strictEqual(receiver.calls.length, 1);
        assert.strictEqual(receiver.calls[0].url.includes('pass2'), true);
    });
});
