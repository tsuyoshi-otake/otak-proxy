import * as assert from 'assert';
import { handleProxyChanged, handleProxyStateChanged, handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { commitUnlessStale } from '../../core/GenerationFence';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { saveProxyConfigResults } from '../../core/ProxyConfigStateTracker';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { ErrorAggregator } from '../../errors/ErrorAggregator';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { TestResult } from '../../utils/ProxyUtils';

/**
 * Fail-first coverage for issue #17 P1-3: a completion produced for logical
 * state N must not mutate logical state N+1.
 */
suite('Stale async completions (#17 P1-3)', () => {
    interface Harness {
        state: ProxyState;
        applyCalls: Array<{ url: string; enabled: boolean }>;
        published: ProxyState[];
        context: InitializerContext;
    }

    function createHarness(initial: ProxyState): Harness {
        const harness: Harness = {
            state: { revision: 1, ...initial },
            applyCalls: [],
            published: [],
            context: {} as InitializerContext
        };

        const manager = {
            getState: async () => ({ ...harness.state }),
            saveState: async (next: ProxyState) => {
                harness.state = { ...next, revision: stateRevision(harness.state) + 1 };
            },
            commitState: async (expected: number, next: ProxyState): Promise<StateCommitResult> => {
                if (stateRevision(harness.state) !== expected) {
                    return { kind: 'superseded', current: { ...harness.state } };
                }
                const revision = expected + 1;
                harness.state = { ...next, revision };
                return { kind: 'committed', revision, state: { ...harness.state } };
            }
        };

        harness.context = {
            proxyStateManager: manager,
            publishProxyState: async (state: ProxyState) => {
                harness.published.push({ ...state });
            },
            applyProxySettings: async (url: string, enabled: boolean) => {
                harness.applyCalls.push({ url, enabled });
                return true;
            },
            updateStatusBar: () => undefined,
            userNotifier: { showSuccess: () => undefined },
            sanitizer: { maskPassword: (url: string) => url }
        } as unknown as InitializerContext;

        return harness;
    }

    test('late failed test for A does not disable already-applied B', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080'
        });
        const startedA = captureLogicalGeneration(harness.state);

        harness.state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b.example:8080',
            revision: 2
        };

        const lateFailure: TestResult = {
            success: false,
            proxyUrl: 'http://a.example:8080',
            testUrls: ['https://example.com'],
            errors: [{ url: 'https://example.com', message: 'timeout' }],
            startedGeneration: startedA
        };

        await handleProxyTestComplete(harness.context, { isPending: false }, lateFailure);

        assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
        assert.strictEqual(harness.state.autoModeOff, undefined);
        assert.deepStrictEqual(harness.applyCalls, []);
    });

    test('late successful test for A does not re-apply A over B', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080'
        });
        const startedA = captureLogicalGeneration(harness.state);
        harness.state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b.example:8080',
            revision: 2
        };

        await handleProxyTestComplete(harness.context, { isPending: false }, {
            success: true,
            proxyUrl: 'http://a.example:8080',
            testUrls: ['https://example.com'],
            errors: [],
            startedGeneration: startedA
        });

        assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
        assert.ok(!harness.applyCalls.some(call => call.url.includes('a.example')));
    });

    test('A→B→A late completion for the first A is still discarded', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080'
        });
        const firstA = captureLogicalGeneration(harness.state);
        harness.state = { mode: ProxyMode.Auto, autoProxyUrl: 'http://b.example:8080', revision: 2 };
        harness.state = { mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080', revision: 3 };

        await handleProxyTestComplete(harness.context, { isPending: false }, {
            success: false,
            proxyUrl: 'http://a.example:8080',
            testUrls: [],
            errors: [],
            startedGeneration: firstA
        });

        assert.strictEqual(harness.state.revision, 3);
        assert.notStrictEqual(harness.state.autoModeOff, true);
    });

    test('revision N apply result cannot roll disk back after N+1', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://n.example:8080',
            gitConfigured: true
        });
        const generationN = captureLogicalGeneration(harness.state);

        harness.state = {
            ...harness.state,
            autoProxyUrl: 'http://n-plus-1.example:8080',
            gitConfigured: true,
            revision: 2
        };

        const errors = new ErrorAggregator();
        errors.addError('Git configuration', 'stale retry');
        await saveProxyConfigResults(harness.context.proxyStateManager as never, true, {
            gitSuccess: false,
            vscodeSuccess: true,
            npmSuccess: true,
            terminalEnvSuccess: true,
            gitOutcome: 'failed',
            vscodeOutcome: 'configured',
            npmOutcome: 'configured',
            terminalEnvOutcome: 'configured'
        }, errors, generationN);

        assert.strictEqual(harness.state.autoProxyUrl, 'http://n-plus-1.example:8080');
        assert.strictEqual(harness.state.gitConfigured, true);
        assert.notStrictEqual(harness.state.targetOutcomes?.git, 'failed');
    });

    test('detection completion for A is ignored after B is applied', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080'
        });
        const startedA = captureLogicalGeneration(harness.state);
        harness.state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b.example:8080',
            revision: 2
        };

        await handleProxyChanged(harness.context, {
            proxyUrl: 'http://a.example:8080',
            source: 'environment',
            timestamp: 1,
            success: true,
            proxyReachable: false,
            startedGeneration: startedA,
            testResult: {
                success: false,
                proxyUrl: 'http://a.example:8080',
                testUrls: [],
                errors: []
            }
        } as never);

        assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
    });

    test('reachability callback for A does not mutate B', async () => {
        const harness = createHarness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://b.example:8080',
            proxyReachable: true
        });

        await handleProxyStateChanged(harness.context, {
            proxyUrl: 'http://a.example:8080',
            reachable: false,
            previousState: true
        });

        assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
        assert.notStrictEqual(harness.state.autoModeOff, true);
    });

    test('cross-callback owners all refuse a superseded revision', async () => {
        const owners = [
            'detection',
            'connectionTest',
            'autoMonitoring',
            'stateChanged',
            'applyResults',
            'retry',
            'remediation',
            'startup',
            'sync',
            'remoteState',
            'diagnostics'
        ] as const;

        for (const owner of owners) {
            const harness = createHarness({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });
            const started = captureLogicalGeneration(harness.state);
            harness.state = { ...harness.state, autoProxyUrl: 'http://b.example:8080', revision: 9 };

            const outcome = await commitUnlessStale(
                harness.context.proxyStateManager,
                started,
                owner,
                current => ({ ...current, autoModeOff: true })
            );

            assert.strictEqual(outcome, 'stale', `${owner} must fence stale completions`);
            assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
            assert.notStrictEqual(harness.state.autoModeOff, true);
        }
    });
});
