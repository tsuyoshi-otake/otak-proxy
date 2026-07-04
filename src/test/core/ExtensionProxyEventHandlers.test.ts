import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState } from '../../core/types';
import { TestResult } from '../../utils/ProxyUtils';

suite('ExtensionProxyEventHandlers Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let state: ProxyState;
    let saveStateStub: sinon.SinonStub;
    let applyProxySettingsStub: sinon.SinonStub;
    let updateStatusBarStub: sinon.SinonStub;
    let context: InitializerContext;

    setup(() => {
        sandbox = sinon.createSandbox();
        state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example.com:8080',
            autoModeOff: false,
            usingFallbackProxy: true,
            fallbackProxyUrl: 'http://fallback.example.com:3128',
            gitConfigured: true,
            npmConfigured: true,
            vscodeConfigured: true
        };
        saveStateStub = sandbox.stub().callsFake(async (next: ProxyState) => {
            state = { ...next };
        });
        applyProxySettingsStub = sandbox.stub().resolves(true);
        updateStatusBarStub = sandbox.stub();
        context = {
            proxyStateManager: {
                getState: sandbox.stub().callsFake(async () => ({ ...state })),
                saveState: saveStateStub
            },
            applyProxySettings: applyProxySettingsStub,
            updateStatusBar: updateStatusBarStub
        } as unknown as InitializerContext;
    });

    teardown(() => {
        sandbox.restore();
    });

    test('failed Auto connection test saves Auto OFF and disables managed targets', async () => {
        const testResult: TestResult = {
            success: false,
            proxyUrl: 'http://proxy.example.com:8080',
            testUrls: ['https://example.com'],
            errors: [{ url: 'https://example.com', message: 'timeout' }],
            timestamp: 1234
        };
        const startupTestState = { isPending: true };

        await handleProxyTestComplete(context, startupTestState, testResult);

        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.proxyReachable, false);
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        assert.strictEqual(startupTestState.isPending, false);
        sinon.assert.calledOnce(saveStateStub);
        sinon.assert.calledWith(updateStatusBarStub, sinon.match({ autoModeOff: true, proxyReachable: false }));
        sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, sinon.match({ silent: true }));
        sinon.assert.callOrder(saveStateStub, applyProxySettingsStub);
    });
});
