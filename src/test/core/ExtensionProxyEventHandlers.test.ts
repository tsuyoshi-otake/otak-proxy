import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleProxyChanged, handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyDetectionResult } from '../../monitoring/ProxyMonitor';
import { ProxyMode, ProxyState } from '../../core/types';
import { TestResult } from '../../utils/ProxyUtils';

suite('ExtensionProxyEventHandlers Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let state: ProxyState;
    let saveStateStub: sinon.SinonStub;
    let publishStateStub: sinon.SinonStub;
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
        publishStateStub = sandbox.stub().resolves();
        applyProxySettingsStub = sandbox.stub().resolves(true);
        updateStatusBarStub = sandbox.stub();
        context = {
            proxyStateManager: {
                getState: sandbox.stub().callsFake(async () => ({ ...state })),
                saveState: saveStateStub
            },
            publishProxyState: publishStateStub,
            applyProxySettings: applyProxySettingsStub,
            updateStatusBar: updateStatusBarStub,
            userNotifier: {
                showSuccess: sandbox.stub()
            },
            sanitizer: {
                maskPassword: (url: string) => url
            }
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
        sinon.assert.calledOnceWithExactly(publishStateStub, sinon.match({ autoModeOff: true, proxyReachable: false }));
        sinon.assert.calledWith(updateStatusBarStub, sinon.match({ autoModeOff: true, proxyReachable: false }));
        sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, sinon.match({ silent: true }));
        sinon.assert.callOrder(saveStateStub, publishStateStub, applyProxySettingsStub);
    });

    test('null detection while fallback is engaged is ignored (issue #29 guard)', async () => {
        // With echo suppression active, the monitor legitimately reports "no
        // system proxy" while the fallback proxy is applied. That must not
        // tear down the working fallback.
        state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://fallback.example.com:3128',
            usingFallbackProxy: true,
            fallbackProxyUrl: 'http://fallback.example.com:3128',
            lastDetectionSource: 'fallback'
        };
        const result: ProxyDetectionResult = {
            proxyUrl: null,
            source: null,
            timestamp: Date.now(),
            success: true
        };

        await handleProxyChanged(context, result);

        assert.strictEqual(state.autoProxyUrl, 'http://fallback.example.com:3128');
        assert.strictEqual(state.usingFallbackProxy, true);
        assert.strictEqual(state.lastDetectionSource, 'fallback');
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxySettingsStub);
    });

    test('a genuinely detected proxy replaces the fallback and records provenance', async () => {
        state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://fallback.example.com:3128',
            usingFallbackProxy: true,
            fallbackProxyUrl: 'http://fallback.example.com:3128',
            lastDetectionSource: 'fallback'
        };
        const result: ProxyDetectionResult = {
            proxyUrl: 'http://corp-proxy.example.com:8080',
            source: 'windows',
            timestamp: Date.now(),
            success: true
        };

        await handleProxyChanged(context, result);

        assert.strictEqual(state.autoProxyUrl, 'http://corp-proxy.example.com:8080');
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        assert.strictEqual(state.lastDetectionSource, 'windows');
        sinon.assert.calledWith(applyProxySettingsStub, 'http://corp-proxy.example.com:8080', true);
    });

    test('null detection without fallback still clears the proxy', async () => {
        state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://old-proxy.example.com:8080',
            usingFallbackProxy: false,
            lastDetectionSource: 'windows'
        };
        const result: ProxyDetectionResult = {
            proxyUrl: null,
            source: null,
            timestamp: Date.now(),
            success: true
        };

        await handleProxyChanged(context, result);

        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.lastDetectionSource, undefined);
        sinon.assert.calledWith(applyProxySettingsStub, '', false);
    });
});
