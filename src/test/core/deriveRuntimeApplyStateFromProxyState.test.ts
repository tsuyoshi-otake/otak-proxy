import * as assert from 'assert';
import { ProxyMode } from '../../core/types';
import { deriveRuntimeApplyStateFromProxyState, ProxyIssue } from '../../core/v3Types';

suite('deriveRuntimeApplyStateFromProxyState', () => {
    test('untrusted apply-blocked desired Auto is awaitingUser, not applied', () => {
        const runtime = deriveRuntimeApplyStateFromProxyState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            applyBlocked: 'untrustedWorkspace',
            lastError: 'Proxy settings were not changed because the workspace is untrusted.',
            targetOutcomes: {
                git: 'failed',
                vscode: 'failed',
                npm: 'failed',
                terminalEnv: 'failed'
            }
        });
        assert.strictEqual(runtime, 'awaitingUser');
    });

    test('successful configured Auto is applied', () => {
        const runtime = deriveRuntimeApplyStateFromProxyState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            targetOutcomes: {
                git: 'configured',
                vscode: 'configured',
                npm: 'configured',
                terminalEnv: 'configured'
            }
        });
        assert.strictEqual(runtime, 'applied');
    });

    // #78: a recorded success must not outvote a fresh convergence blocker.
    function observed(impact: ProxyIssue['impact']): ProxyIssue {
        return {
            id: 'git.managedProxyResidual',
            fingerprint: 'git.managedProxyResidual:test',
            category: 'applyFailed',
            impact,
            targetId: 'git.global.proxy',
            targetHost: 'workspaceHost',
            source: 'test',
            capability: 'readOnly',
            autoAction: 'none',
            userAction: 'showDetails',
            evidence: {}
        };
    }

    const recordedOffSuccess = {
        mode: ProxyMode.Off,
        targetOutcomes: {
            git: 'configured' as const,
            vscode: 'configured' as const,
            npm: 'cleared' as const,
            terminalEnv: 'cleared' as const
        }
    };

    test('a recorded success with a fresh convergence blocker is partial, not applied', () => {
        assert.strictEqual(deriveRuntimeApplyStateFromProxyState(recordedOffSuccess, [observed('blocksConvergence')]), 'partial');
        assert.strictEqual(deriveRuntimeApplyStateFromProxyState(recordedOffSuccess), 'applied');
    });

    test('non-blocking observations never change the recorded state', () => {
        for (const impact of ['requiresUserDecision', 'advisoryResidualRisk', 'informational'] as const) {
            assert.strictEqual(deriveRuntimeApplyStateFromProxyState(recordedOffSuccess, [observed(impact)]), 'applied', impact);
        }
    });

    test('observations do not turn a state without recorded writes into a write result', () => {
        assert.strictEqual(deriveRuntimeApplyStateFromProxyState({ mode: ProxyMode.Off }, [observed('blocksConvergence')]), 'diagnosed');
        assert.strictEqual(deriveRuntimeApplyStateFromProxyState({
            mode: ProxyMode.Auto,
            applyBlocked: 'untrustedWorkspace',
            targetOutcomes: { git: 'failed' }
        }, [observed('blocksConvergence')]), 'awaitingUser');
    });
});
