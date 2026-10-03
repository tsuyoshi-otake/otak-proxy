import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleProxyChanged, handleProxyStateChanged, handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyDetectionResult } from '../../monitoring/ProxyMonitor';
import { ProxyMode, ProxyState } from '../../core/types';
import { TestResult } from '../../utils/ProxyUtils';
import type { ManualFallbackOutcome } from '../../core/SystemProxyUpdateService';
import { InputSanitizer } from '../../validation/InputSanitizer';

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
                showSuccess: sandbox.stub(),
                showWarning: sandbox.stub()
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
            errors: [{ url: 'https://example.com', message: 'connect ECONNREFUSED 127.0.0.1:9' }],
            failureKind: 'endpointUnreachable',
            proxyEndpointOk: false,
            canaryHost: 'example.com',
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

    test('407 authRequired does not Auto OFF or clear managed targets', async () => {
        const testResult: TestResult = {
            success: false,
            proxyUrl: 'http://proxy.example.com:8080',
            testUrls: ['https://www.github.com'],
            errors: [{ url: 'https://www.github.com', message: 'Proxy CONNECT failed with status 407' }],
            failureKind: 'authRequired',
            proxyEndpointOk: true,
            canaryHost: 'www.github.com',
            timestamp: 1234
        };

        await handleProxyTestComplete(context, { isPending: false }, testResult);

        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.proxyReachable, true);
        assert.strictEqual(state.usingFallbackProxy, true);
        assert.strictEqual(state.fallbackProxyUrl, 'http://fallback.example.com:3128');
        sinon.assert.calledOnce(saveStateStub);
        sinon.assert.neverCalledWith(applyProxySettingsStub, '', false, sinon.match({ silent: true }));
        sinon.assert.notCalled(applyProxySettingsStub);
    });

    test('403 destinationForbidden does not Auto OFF or clear managed targets', async () => {
        const testResult: TestResult = {
            success: false,
            proxyUrl: 'http://proxy.example.com:8080',
            testUrls: ['https://www.google.com'],
            errors: [{ url: 'https://www.google.com', message: 'Proxy CONNECT failed with status 403' }],
            failureKind: 'destinationForbidden',
            proxyEndpointOk: true,
            canaryHost: 'www.google.com',
            timestamp: 1234
        };

        await handleProxyTestComplete(context, { isPending: false }, testResult);

        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.proxyReachable, true);
        sinon.assert.notCalled(applyProxySettingsStub);
    });

    test('timeout canary failure does not Auto OFF or clear managed targets', async () => {
        const testResult: TestResult = {
            success: false,
            proxyUrl: 'http://proxy.example.com:8080',
            testUrls: ['https://www.microsoft.com'],
            errors: [{ url: 'https://www.microsoft.com', message: 'Connection timeout (3000ms)' }],
            failureKind: 'timeout',
            proxyEndpointOk: false,
            canaryHost: 'www.microsoft.com',
            timestamp: 1234
        };

        await handleProxyTestComplete(context, { isPending: false }, testResult);

        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.proxyReachable, true);
        sinon.assert.notCalled(applyProxySettingsStub);
    });

    test('success:false without failureKind is not enough to clear managed targets', async () => {
        const testResult: TestResult = {
            success: false,
            proxyUrl: 'http://proxy.example.com:8080',
            testUrls: ['https://example.com'],
            errors: [{ url: 'https://example.com', message: 'timeout' }],
            timestamp: 1234
        };

        await handleProxyTestComplete(context, { isPending: false }, testResult);

        assert.strictEqual(state.autoModeOff, false);
        sinon.assert.notCalled(applyProxySettingsStub);
    });

    test('reachability false still Auto OFF and disables managed targets', async () => {
        await handleProxyStateChanged(context, {
            proxyUrl: 'http://proxy.example.com:8080',
            reachable: false,
            previousState: true
        });

        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.proxyReachable, false);
        sinon.assert.calledOnceWithExactly(applyProxySettingsStub, 'http://proxy.example.com:8080', false, sinon.match({ silent: true }));
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

        const resolveManualFallback = sandbox.stub().resolves('engaged');

        await handleProxyChanged(context, result, resolveManualFallback);

        sinon.assert.notCalled(resolveManualFallback);
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

    test('unsupported PAC detection does not apply none', async () => {
        state = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://old-proxy.example.com:8080',
            usingFallbackProxy: false,
            lastDetectionSource: 'windows'
        };
        const result: ProxyDetectionResult = {
            proxyUrl: null,
            source: 'windows',
            kind: 'pac',
            capability: 'unsupported',
            timestamp: Date.now(),
            success: true
        };

        await handleProxyChanged(context, result);

        assert.strictEqual(state.autoProxyUrl, 'http://old-proxy.example.com:8080');
        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.systemProxyDetected, true);
        assert.strictEqual(state.lastDetectionKind, 'pac');
        assert.strictEqual(state.lastDetectionCapability, 'unsupported');
        sinon.assert.notCalled(applyProxySettingsStub);
        sinon.assert.calledOnce(saveStateStub);
    });

    test('apply-blocked Auto does not toast success or paint the pre-apply snapshot', async () => {
        const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;
        applyProxySettingsStub.callsFake(async () => {
            state.lastError = 'Proxy settings were not changed because the workspace is untrusted.';
            state.applyBlocked = 'untrustedWorkspace';
            return false;
        });
        const result: ProxyDetectionResult = {
            proxyUrl: 'http://corp-proxy.example.com:8080',
            source: 'windows',
            timestamp: Date.now(),
            success: true
        };

        await handleProxyChanged(context, result);

        sinon.assert.calledOnce(applyProxySettingsStub);
        sinon.assert.notCalled(showSuccess);
        sinon.assert.calledWith(updateStatusBarStub, sinon.match({
            applyBlocked: 'untrustedWorkspace',
            lastError: sinon.match(/untrusted/i)
        }));
    });

    suite('system proxy lost mid-session (#85)', () => {
        const lostProxy = 'http://corp-proxy.example.com:8080';
        const manualUrl = 'http://alice:s3cret@fallback.example.com:3128';
        const lossResult = (): ProxyDetectionResult => ({
            proxyUrl: null,
            source: null,
            timestamp: Date.now(),
            success: true
        });

        // Stands in for SystemProxyUpdateService.resolveManualFallback: the
        // documented state mutation for each outcome, nothing else.
        const resolverFor = (outcome: ManualFallbackOutcome) => sandbox.stub().callsFake(async (draft: ProxyState) => {
            if (outcome === 'engaged') {
                draft.autoProxyUrl = draft.manualProxyUrl;
                draft.autoModeOff = false;
                draft.usingFallbackProxy = true;
                draft.fallbackProxyUrl = draft.manualProxyUrl;
                draft.lastDetectionSource = 'fallback';
            } else if (outcome === 'unreachable') {
                draft.autoProxyUrl = undefined;
                draft.autoModeOff = true;
                draft.usingFallbackProxy = false;
                draft.fallbackProxyUrl = undefined;
                draft.lastDetectionSource = undefined;
            }
            return outcome;
        });

        setup(() => {
            state = {
                mode: ProxyMode.Auto,
                autoProxyUrl: lostProxy,
                autoModeOff: false,
                usingFallbackProxy: false,
                lastDetectionSource: 'windows',
                manualProxyUrl: manualUrl
            };
            context.sanitizer = new InputSanitizer() as unknown as InitializerContext['sanitizer'];
        });

        test('a reachable manual fallback replaces the lost proxy and says so without the password', async () => {
            const resolve = resolverFor('engaged');
            const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;

            await handleProxyChanged(context, lossResult(), resolve);

            sinon.assert.calledOnce(resolve);
            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, manualUrl, true, undefined);
            assert.strictEqual(state.autoProxyUrl, manualUrl);
            assert.strictEqual(state.usingFallbackProxy, true);
            assert.strictEqual(state.fallbackProxyUrl, manualUrl);
            assert.strictEqual(state.lastDetectionSource, 'fallback');
            assert.strictEqual(state.autoModeOff, false);
            assert.strictEqual(state.convergencePending, false);
            sinon.assert.calledOnce(showSuccess);
            const [key, params] = showSuccess.firstCall.args;
            assert.strictEqual(key, 'fallback.usingManualProxy');
            assert.ok(!String(params.url).includes('s3cret'), `password leaked: ${params.url}`);
            assert.ok(String(params.url).includes('fallback.example.com:3128'));
        });

        test('an unreachable manual fallback turns Auto OFF and removes the lost proxy', async () => {
            const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;

            await handleProxyChanged(context, lossResult(), resolverFor('unreachable'));

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, undefined);
            assert.strictEqual(state.autoProxyUrl, undefined);
            assert.strictEqual(state.autoModeOff, true);
            assert.strictEqual(state.usingFallbackProxy, false);
            sinon.assert.calledOnceWithExactly(showSuccess, 'message.systemProxyRemoved');
        });

        test('without a usable fallback the lost proxy is cleared as before', async () => {
            const resolve = resolverFor('notConfigured');

            await handleProxyChanged(context, lossResult(), resolve);

            sinon.assert.calledOnce(resolve);
            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, undefined);
            assert.strictEqual(state.autoProxyUrl, undefined);
            assert.strictEqual(state.autoModeOff, false);
            assert.strictEqual(state.usingFallbackProxy, false);
        });

        test('a failing fallback resolution still clears the lost proxy', async () => {
            const resolve = sandbox.stub().rejects(new Error('tester crashed'));

            await handleProxyChanged(context, lossResult(), resolve);

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, undefined);
            assert.strictEqual(state.autoProxyUrl, undefined);
            assert.strictEqual(state.usingFallbackProxy, false);
            assert.strictEqual(state.convergencePending, false);
        });

        test('a detected proxy never consults the fallback', async () => {
            const resolve = resolverFor('engaged');

            await handleProxyChanged(context, {
                proxyUrl: 'http://other-proxy.example.com:8080',
                source: 'windows',
                timestamp: Date.now(),
                success: true
            }, resolve);

            sinon.assert.notCalled(resolve);
            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, 'http://other-proxy.example.com:8080', true, undefined);
        });

        test('a toggle committed during the fallback test drops the fallback result', async () => {
            const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;
            const engage = resolverFor('engaged');
            const resolve = sandbox.stub().callsFake(async (draft: ProxyState) => {
                // The user toggles Off while the fallback connection test runs.
                state = { ...state, mode: ProxyMode.Off, revision: 7 };
                return engage(draft);
            });

            await handleProxyChanged(context, lossResult(), resolve);

            sinon.assert.notCalled(applyProxySettingsStub);
            sinon.assert.notCalled(saveStateStub);
            sinon.assert.notCalled(showSuccess);
            assert.strictEqual(state.mode, ProxyMode.Off);
            assert.strictEqual(state.usingFallbackProxy, false);
        });

        test('a fallback with the same URL as the lost proxy still records the fallback', async () => {
            state.autoProxyUrl = manualUrl;

            await handleProxyChanged(context, lossResult(), resolverFor('engaged'));

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, manualUrl, true, undefined);
            assert.strictEqual(state.usingFallbackProxy, true);
            assert.strictEqual(state.fallbackProxyUrl, manualUrl);
            assert.strictEqual(state.lastDetectionSource, 'fallback');
        });
    });
});
