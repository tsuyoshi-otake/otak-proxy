import * as assert from 'assert';
import * as sinon from 'sinon';
import { handleProxyChanged, handleProxyStateChanged, handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyDetectionResult } from '../../monitoring/ProxyMonitor';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyMode, ProxyState } from '../../core/types';
import { isProxyEndpointReachable, TestResult } from '../../utils/ProxyUtils';
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

    /**
     * #93 item 4: the monitor path dropped the per-scheme endpoints and the
     * bypass of a new detection, so the previous detection's values stayed in
     * state, and diagnostics compared npm against them (false, retryable
     * npm.managedProxyMismatch). ProxyApplier reads these committed fields.
     */
    suite('monitor-detected split routing (#93)', () => {
        const primary = 'http://proxy.example.com:8080';
        const secure = 'http://secure.example.com:8443';
        let atApply: ProxyState | undefined;

        const detection = (fields: Partial<ProxyDetectionResult>): ProxyDetectionResult => ({
            proxyUrl: primary,
            source: 'windows',
            timestamp: Date.now(),
            success: true,
            proxyReachable: true,
            ...fields
        });

        setup(() => {
            state = {
                mode: ProxyMode.Auto,
                autoProxyUrl: primary,
                autoModeOff: false,
                usingFallbackProxy: false,
                lastDetectionSource: 'windows',
                autoProxyKind: 'perSchemeProxy',
                autoHttpProxyUrl: primary,
                autoHttpsProxyUrl: secure,
                gitConfigured: true,
                npmConfigured: true,
                vscodeConfigured: true
            };
            atApply = undefined;
            applyProxySettingsStub.callsFake(async () => {
                atApply = { ...state };
                return true;
            });
        });

        test('a new primary URL does not keep the previous per-scheme https endpoint', async () => {
            await handleProxyChanged(context, detection({ proxyUrl: 'http://proxy2.example.com:8080', kind: 'singleProxy' }));

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, 'http://proxy2.example.com:8080', true, undefined);
            assert.ok(atApply);
            assert.strictEqual(atApply.autoProxyKind, 'singleProxy');
            assert.strictEqual(atApply.autoHttpsProxyUrl, undefined, 'apply must not see the stale https endpoint');
            assert.strictEqual(state.autoHttpProxyUrl, undefined);
            assert.strictEqual(state.autoHttpsProxyUrl, undefined);
        });

        test('an https-only change with the same primary URL is applied with the new endpoint', async () => {
            const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;
            const secure2 = 'http://secure2.example.com:8443';

            await handleProxyChanged(context, detection({ kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure2 }));

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, undefined);
            assert.ok(atApply);
            assert.strictEqual(atApply.autoHttpsProxyUrl, secure2);
            assert.strictEqual(state.autoHttpsProxyUrl, secure2);
            // Same notification SystemProxyUpdateService already shows for an https-only change.
            sinon.assert.calledWith(showSuccess, 'message.systemProxyChanged', { url: primary });
        });

        test('per-scheme back to a single proxy with the same primary URL is applied and clears https', async () => {
            await handleProxyChanged(context, detection({ kind: 'singleProxy' }));

            sinon.assert.calledOnce(applyProxySettingsStub);
            assert.ok(atApply);
            assert.strictEqual(atApply.autoProxyKind, 'singleProxy');
            assert.strictEqual(atApply.autoHttpsProxyUrl, undefined);
        });

        test('a bypass-only change is applied with the new bypass', async () => {
            const bypass = 'localhost;*.internal.example.com';

            await handleProxyChanged(context, detection({ kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure, bypass }));

            sinon.assert.calledOnce(applyProxySettingsStub);
            assert.ok(atApply);
            assert.strictEqual(atApply.detectedBypass, bypass);
            assert.strictEqual(atApply.autoHttpsProxyUrl, secure);
        });

        test('an identical detection stays on the unchanged path', async () => {
            await handleProxyChanged(context, detection({ kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure }));

            sinon.assert.notCalled(applyProxySettingsStub);
            sinon.assert.calledOnce(saveStateStub);
            assert.strictEqual(state.autoHttpsProxyUrl, secure);
        });

        test('a single proxy reporting its own http/https copies does not count as a split change', async () => {
            state.autoProxyKind = 'singleProxy';
            state.autoHttpProxyUrl = undefined;
            state.autoHttpsProxyUrl = undefined;

            await handleProxyChanged(context, detection({ kind: 'singleProxy', httpUrl: primary, httpsUrl: primary }));

            sinon.assert.notCalled(applyProxySettingsStub);
        });

        suite('under Auto: OFF', () => {
            // What Auto: OFF looks like after it removed the proxy: the removal
            // leaves every managed target's Configured flag false.
            setup(() => {
                state.autoModeOff = true;
                state.proxyReachable = false;
                state.gitConfigured = false;
                state.npmConfigured = false;
                state.vscodeConfigured = false;
            });

            test('a split-only change is saved for the recovery, not applied to the unreachable proxy', async () => {
                // The monitor runs no connection test when only the split changes,
                // so reachability is unknown; Auto: OFF already says this URL does not answer.
                const secure2 = 'http://secure2.example.com:8443';

                await handleProxyChanged(context, detection({
                    kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure2, proxyReachable: undefined
                }));

                sinon.assert.notCalled(applyProxySettingsStub);
                sinon.assert.calledOnce(saveStateStub);
                assert.strictEqual(state.autoModeOff, true);
                assert.strictEqual(state.autoHttpsProxyUrl, secure2, 'the reachability recovery applies the saved endpoint');
            });

            test('a kind and bypass change saves the detection fields together', async () => {
                const bypass = 'localhost';
                state.lastDetectionKind = 'perSchemeProxy';

                await handleProxyChanged(context, detection({ kind: 'singleProxy', bypass, proxyReachable: undefined }));

                sinon.assert.notCalled(applyProxySettingsStub);
                assert.strictEqual(state.autoProxyKind, 'singleProxy');
                assert.strictEqual(state.lastDetectionKind, 'singleProxy');
                assert.strictEqual(state.autoHttpsProxyUrl, undefined);
                assert.strictEqual(state.detectedBypass, bypass);
            });

            test('the same detection without a new test does not retry the removed targets as enable failures', async () => {
                await handleProxyChanged(context, detection({
                    kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure, proxyReachable: undefined
                }));

                sinon.assert.notCalled(applyProxySettingsStub);
                assert.strictEqual(state.autoModeOff, true);
            });

            test('a new failed test still goes through the removal path as before', async () => {
                const testResult: TestResult = {
                    success: false,
                    proxyUrl: primary,
                    testUrls: ['https://example.com'],
                    errors: [{ url: 'https://example.com', message: 'connect ECONNREFUSED 127.0.0.1:9' }],
                    failureKind: 'endpointUnreachable',
                    proxyEndpointOk: false
                };

                await handleProxyChanged(context, detection({
                    kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure, testResult, proxyReachable: false
                }));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, false, undefined);
                assert.strictEqual(state.autoModeOff, true);
            });

            test('a successful test with a split change recovers and applies the new endpoint', async () => {
                const secure2 = 'http://secure2.example.com:8443';
                const testResult: TestResult = { success: true, proxyUrl: primary, testUrls: ['https://example.com'], errors: [] };

                await handleProxyChanged(context, detection({
                    kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure2, testResult, proxyReachable: true
                }));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, undefined);
                assert.ok(atApply);
                assert.strictEqual(atApply.autoModeOff, false);
                assert.strictEqual(atApply.autoHttpsProxyUrl, secure2);
            });
        });

        test('no detected proxy clears the split fields', async () => {
            state.detectedBypass = 'localhost';

            await handleProxyChanged(context, detection({ proxyUrl: null, source: null }));

            sinon.assert.calledOnceWithExactly(applyProxySettingsStub, '', false, undefined);
            assert.strictEqual(state.autoProxyKind, undefined);
            assert.strictEqual(state.autoHttpProxyUrl, undefined);
            assert.strictEqual(state.autoHttpsProxyUrl, undefined);
            assert.strictEqual(state.detectedBypass, undefined);
        });
    });

    /**
     * #97: Auto: OFF is a verdict about one endpoint. It is entered on proof
     * that the endpoint is unreachable and left on proof that it is alive: a
     * success, a proxy response (407/403/5xx), or a TCP connection to the
     * proxy. A test that proves neither keeps the verdict for the same
     * endpoint; a new endpoint starts without one (#67: only proven
     * unreachability turns it OFF). Nothing enables while Auto: OFF holds.
     */
    suite('Auto: OFF endpoint verdict (#97)', () => {
        const primary = 'http://proxy.example.com:8080';
        const other = 'http://proxy2.example.com:8080';
        const secure2 = 'http://secure2.example.com:8443';
        const startup = () => ({ isPending: false });
        let atApply: ProxyState[];

        const failed = (proxyUrl: string, fields: Partial<TestResult>): TestResult => ({
            success: false,
            proxyUrl,
            testUrls: ['https://www.github.com'],
            errors: [{ url: 'https://www.github.com', message: 'canary failed' }],
            proxyEndpointOk: false,
            ...fields
        });

        type Variant = { name: string; verdict: 'alive' | 'unknown' | 'unreachable'; make: (url: string) => TestResult };
        const variants: Variant[] = [
            { name: 'success', verdict: 'alive', make: url => ({ success: true, proxyUrl: url, testUrls: ['https://www.github.com'], errors: [], proxyEndpointOk: true }) },
            { name: '407 authRequired', verdict: 'alive', make: url => failed(url, { failureKind: 'authRequired', proxyEndpointOk: true }) },
            { name: '403 destinationForbidden', verdict: 'alive', make: url => failed(url, { failureKind: 'destinationForbidden', proxyEndpointOk: true }) },
            { name: '502 connectRejected', verdict: 'alive', make: url => failed(url, { failureKind: 'connectRejected', proxyEndpointOk: true }) },
            { name: 'timeout after the TCP connection', verdict: 'alive', make: url => failed(url, { failureKind: 'timeout', proxyConnected: true }) },
            { name: 'timeout before any TCP connection', verdict: 'unknown', make: url => failed(url, { failureKind: 'timeout' }) },
            { name: 'proxy host DNS failure', verdict: 'unknown', make: url => failed(url, { failureKind: 'dns' }) },
            { name: 'TLS failure', verdict: 'unknown', make: url => failed(url, { failureKind: 'protocol' }) },
            { name: 'endpointUnreachable', verdict: 'unreachable', make: url => failed(url, { failureKind: 'endpointUnreachable' }) }
        ];
        const byVerdict = (verdict: Variant['verdict']) => variants.filter(variant => variant.verdict === verdict);
        const success = byVerdict('alive')[0];
        const authRequired = byVerdict('alive')[1];
        const timeoutBeforeConnect = byVerdict('unknown')[0];
        const dnsFailure = byVerdict('unknown')[1];
        const unreachable = byVerdict('unreachable')[0];

        const detection = (
            proxyUrl: string,
            testResult?: TestResult,
            fields: Partial<ProxyDetectionResult> = {}
        ): ProxyDetectionResult => ({
            proxyUrl,
            source: 'windows',
            timestamp: Date.now(),
            success: true,
            ...(testResult ? { testResult, proxyReachable: isProxyEndpointReachable(testResult) } : {}),
            ...fields
        });
        const splitChange: Partial<ProxyDetectionResult> = { kind: 'perSchemeProxy', httpUrl: primary, httpsUrl: secure2 };

        const enableCalls = () => applyProxySettingsStub.getCalls().filter(call => call.args[1] === true);
        const assertNothingEnabledUnderAutoOff = (label: string) => {
            applyProxySettingsStub.getCalls().forEach((call, index) => {
                if (call.args[1] === true) {
                    assert.strictEqual(atApply[index].autoModeOff, false, `${label} enable #${index} ran under Auto: OFF`);
                }
            });
            if (state.autoModeOff === true) {
                assert.strictEqual(enableCalls().length, 0, `${label} Auto: OFF must not end with the proxy enabled`);
            }
        };

        const removalCalls = () => applyProxySettingsStub.getCalls().filter(call => call.args[1] === false);
        /** Compare-and-set commits, as ProxyStateManager does in production. */
        const useRevisionedStore = () => {
            state = { ...state, revision: 5 };
            (context.proxyStateManager as unknown as { commitState: unknown }).commitState =
                async (expectedRevision: number, next: ProxyState) => {
                    if ((state.revision ?? 0) !== expectedRevision) {
                        return { kind: 'superseded' as const, current: { ...state } };
                    }
                    state = { ...next, revision: expectedRevision + 1 };
                    return { kind: 'committed' as const, revision: expectedRevision + 1, state: { ...state } };
                };
        };
        const autoOnState = () => offState({
            autoModeOff: false,
            proxyReachable: true,
            gitConfigured: true,
            npmConfigured: true,
            vscodeConfigured: true
        });

        const offState = (overrides: Partial<ProxyState> = {}): ProxyState => ({
            // Auto: OFF after it removed the proxy: every Configured flag is false.
            mode: ProxyMode.Auto,
            autoProxyUrl: primary,
            autoModeOff: true,
            proxyReachable: false,
            usingFallbackProxy: false,
            lastDetectionSource: 'windows',
            autoProxyKind: 'singleProxy',
            gitConfigured: false,
            npmConfigured: false,
            vscodeConfigured: false,
            ...overrides
        });

        setup(() => {
            state = offState();
            atApply = [];
            applyProxySettingsStub.callsFake(async () => {
                atApply.push({ ...state });
                return true;
            });
        });

        suite('a detection of the same endpoint', () => {
            for (const variant of byVerdict('alive')) {
                test(`${variant.name} leaves Auto: OFF and applies`, async () => {
                    await handleProxyChanged(context, detection(primary, variant.make(primary), splitChange));

                    sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, undefined);
                    assert.strictEqual(atApply[0].autoModeOff, false);
                    assert.strictEqual(atApply[0].autoHttpsProxyUrl, secure2);
                    assert.strictEqual(state.autoModeOff, false);
                });
            }

            for (const variant of byVerdict('unknown')) {
                test(`${variant.name} keeps Auto: OFF and only saves the detection`, async () => {
                    const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;

                    await handleProxyChanged(context, detection(primary, variant.make(primary), splitChange));

                    sinon.assert.notCalled(applyProxySettingsStub);
                    sinon.assert.notCalled(showSuccess);
                    assert.strictEqual(state.autoModeOff, true);
                    assert.strictEqual(state.autoHttpsProxyUrl, secure2, 'saved for the recovery to apply');
                    assert.strictEqual(state.lastTestResult?.failureKind, variant.make(primary).failureKind);
                });
            }

            test('endpointUnreachable keeps Auto: OFF and repeats the removal', async () => {
                await handleProxyChanged(context, detection(primary, unreachable.make(primary), splitChange));

                assert.strictEqual(enableCalls().length, 0);
                assert.strictEqual(removalCalls().length, 1, 'same as before #97: a new unreachable result goes through apply');
                assert.strictEqual(state.autoModeOff, true);
            });
        });

        suite('a detection of a new endpoint', () => {
            for (const variant of [...byVerdict('alive'), ...byVerdict('unknown')]) {
                test(`${variant.name} starts the new endpoint in Auto and applies it`, async () => {
                    // Auto: OFF with no proxy at all (fallback missing or unreachable).
                    state = offState({ autoProxyUrl: undefined, autoProxyKind: undefined, lastDetectionSource: undefined });
                    const showSuccess = context.userNotifier.showSuccess as sinon.SinonStub;

                    await handleProxyChanged(context, detection(other, variant.make(other)));

                    sinon.assert.calledOnceWithExactly(applyProxySettingsStub, other, true, undefined);
                    assert.strictEqual(atApply[0].autoModeOff, false);
                    assert.strictEqual(state.autoModeOff, false);
                    // Unchanged notification rule: an applied detection says so.
                    sinon.assert.calledWith(showSuccess, 'message.systemProxyChanged', { url: other });
                });
            }

            test('a new endpoint without a connection test starts in Auto and applies it', async () => {
                await handleProxyChanged(context, detection(other));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, other, true, undefined);
                assert.strictEqual(atApply[0].autoModeOff, false);
                assert.strictEqual(state.autoModeOff, false);
            });

            test('a new endpoint replacing the unreachable one is judged on its own test', async () => {
                await handleProxyChanged(context, detection(other, dnsFailure.make(other)));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, other, true, undefined);
                assert.strictEqual(state.autoProxyUrl, other);
                assert.strictEqual(state.autoModeOff, false);
            });

            test('an unreachable new endpoint stays Auto: OFF and is not enabled', async () => {
                state = offState({ autoProxyUrl: undefined });

                await handleProxyChanged(context, detection(other, unreachable.make(other)));

                assert.strictEqual(enableCalls().length, 0);
                assert.strictEqual(state.autoModeOff, true);
            });
        });

        suite('a connection test of the current endpoint', () => {
            for (const variant of byVerdict('alive')) {
                test(`${variant.name} leaves Auto: OFF and applies in the same step`, async () => {
                    await handleProxyTestComplete(context, startup(), variant.make(primary));

                    sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, sinon.match({ silent: true }));
                    assert.strictEqual(atApply[0].autoModeOff, false);
                    assert.strictEqual(state.autoModeOff, false);
                });
            }

            for (const variant of byVerdict('unknown')) {
                test(`${variant.name} keeps Auto: OFF`, async () => {
                    await handleProxyTestComplete(context, startup(), variant.make(primary));

                    sinon.assert.notCalled(applyProxySettingsStub);
                    assert.strictEqual(state.autoModeOff, true);
                });
            }

            test('endpointUnreachable keeps Auto: OFF and only re-runs the removal', async () => {
                await handleProxyTestComplete(context, startup(), unreachable.make(primary));

                assert.strictEqual(enableCalls().length, 0);
                assert.strictEqual(state.autoModeOff, true);
            });

            test('a test of another endpoint changes nothing, even with a generation stamp', async () => {
                // The verdict belongs to the endpoint the test reached. The
                // proxyChanged event that follows owns a new endpoint; a commit
                // here would make that event stale and drop it.
                const startedGeneration = captureLogicalGeneration(state);
                const before = { ...state };

                await handleProxyTestComplete(context, startup(), { ...success.make(other), startedGeneration });

                sinon.assert.notCalled(saveStateStub);
                sinon.assert.notCalled(applyProxySettingsStub);
                assert.deepStrictEqual(state, before);
            });

            test('a 407 while Auto is on changes nothing', async () => {
                state = offState({
                    autoModeOff: false,
                    proxyReachable: true,
                    gitConfigured: true,
                    npmConfigured: true,
                    vscodeConfigured: true
                });

                await handleProxyTestComplete(context, startup(), authRequired.make(primary));

                sinon.assert.notCalled(applyProxySettingsStub);
                assert.strictEqual(state.autoModeOff, false);
            });

            test('a toggle committed before the recovery apply drops the apply', async () => {
                publishStateStub.callsFake(async () => {
                    state = { ...state, mode: ProxyMode.Off };
                });

                await handleProxyTestComplete(context, startup(), success.make(primary));

                sinon.assert.notCalled(applyProxySettingsStub);
            });

            test('a detection that moved to another endpoint before the recovery apply drops the apply', async () => {
                publishStateStub.callsFake(async () => {
                    state = { ...state, autoProxyUrl: other };
                });

                await handleProxyTestComplete(context, startup(), success.make(primary));

                sinon.assert.notCalled(applyProxySettingsStub);
            });

            test('Auto: OFF set again before the recovery apply drops the apply', async () => {
                publishStateStub.callsFake(async () => {
                    state = { ...state, autoModeOff: true };
                });

                await handleProxyTestComplete(context, startup(), success.make(primary));

                sinon.assert.notCalled(applyProxySettingsStub);
            });

            test('with compare-and-set commits, an unreachable test removes the proxy after its own commit', async () => {
                // Before #97 the removal compared the state with the test's
                // start generation, which its own commit had just advanced, so
                // it never ran.
                state = autoOnState();
                useRevisionedStore();

                await handleProxyTestComplete(context, startup(), unreachable.make(primary));

                assert.strictEqual(enableCalls().length, 0);
                assert.strictEqual(removalCalls().length, 1);
                assert.strictEqual(state.autoModeOff, true);
            });

            test('with compare-and-set commits, an alive test recovers after its own commit', async () => {
                useRevisionedStore();

                await handleProxyTestComplete(context, startup(), success.make(primary));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, sinon.match({ silent: true }));
                assert.strictEqual(atApply[0].autoModeOff, false);
            });

            test('with compare-and-set commits, a re-enable committed before the removal keeps the proxy', async () => {
                // Mode, URL and endpoint still match; only the revision shows
                // that the state is no longer the one this test wrote.
                state = autoOnState();
                useRevisionedStore();
                publishStateStub.callsFake(async () => {
                    state = { ...state, autoModeOff: false, revision: (state.revision ?? 0) + 1 };
                });

                await handleProxyTestComplete(context, startup(), unreachable.make(primary));

                assert.strictEqual(removalCalls().length, 0);
                assert.strictEqual(state.autoModeOff, false);
            });
        });

        suite('a reachability flip', () => {
            test('a flip to reachable does not enable while Auto: OFF holds', async () => {
                await handleProxyStateChanged(context, { proxyUrl: primary, reachable: true, previousState: false });

                sinon.assert.notCalled(applyProxySettingsStub);
                assert.strictEqual(state.autoModeOff, true);
                assert.strictEqual(state.proxyReachable, true);
            });

            test('a flip to reachable while Auto is on re-applies as before', async () => {
                state = offState({ autoModeOff: false, gitConfigured: true, npmConfigured: true, vscodeConfigured: true });

                await handleProxyStateChanged(context, { proxyUrl: primary, reachable: true, previousState: false });

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, sinon.match({ silent: true }));
                assert.strictEqual(state.autoModeOff, false);
            });

            test('an alive test after the flip was spent on an unknown one still recovers', async () => {
                // Monitor order: test complete, then the flip. The flip fires
                // once, on the unknown test; the later alive test brings none.
                await handleProxyTestComplete(context, startup(), timeoutBeforeConnect.make(primary));
                await handleProxyStateChanged(context, { proxyUrl: primary, reachable: true, previousState: false });
                sinon.assert.notCalled(applyProxySettingsStub);

                await handleProxyTestComplete(context, startup(), success.make(primary));

                sinon.assert.calledOnceWithExactly(applyProxySettingsStub, primary, true, sinon.match({ silent: true }));
                assert.strictEqual(state.autoModeOff, false);
            });
        });

        test('no detection enables under Auto: OFF, and Auto: OFF follows the verdict table', async () => {
            const expectedOff = (wasOff: boolean, sameEndpoint: boolean, verdict?: Variant['verdict']): boolean => {
                if (verdict === 'unreachable') {
                    return true;
                }
                if (verdict === 'alive') {
                    return false;
                }
                return sameEndpoint && wasOff;
            };

            for (const wasOff of [true, false]) {
                for (const previous of [primary, undefined]) {
                    for (const detected of [primary, other]) {
                        for (const variant of [undefined, ...variants]) {
                            for (const split of [false, true]) {
                                const label = `[off=${wasOff} prev=${previous} det=${detected} test=${variant?.name ?? 'none'} split=${split}]`;
                                state = offState({
                                    autoProxyUrl: previous,
                                    autoModeOff: wasOff,
                                    gitConfigured: !wasOff,
                                    npmConfigured: !wasOff,
                                    vscodeConfigured: !wasOff
                                });
                                atApply = [];
                                applyProxySettingsStub.resetHistory();

                                await handleProxyChanged(context, detection(detected, variant?.make(detected), split ? splitChange : {}));

                                assertNothingEnabledUnderAutoOff(label);
                                assert.strictEqual(state.autoModeOff, expectedOff(wasOff, previous === detected, variant?.verdict), label);
                                if (wasOff && state.autoModeOff === false) {
                                    assert.strictEqual(enableCalls().length, 1, `${label} leaving Auto: OFF must apply`);
                                }
                            }
                        }
                    }
                }
            }
        });
    });
});
