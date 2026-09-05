import * as assert from 'assert';
import { ProxyMode } from '../../core/types';
import { deriveRuntimeApplyStateFromProxyState } from '../../core/v3Types';

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
});
