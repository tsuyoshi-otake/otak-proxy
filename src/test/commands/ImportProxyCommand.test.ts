import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeImportProxy } from '../../commands/ImportProxyCommand';
import { CommandContext } from '../../commands/types';
import { ProxyMode, ProxyState } from '../../core/types';
import { I18nManager } from '../../i18n/I18nManager';
import * as DetectUtils from '../../utils/SystemProxyDetectionUtils';
import * as ConnectionTest from '../../utils/ProxyConnectionTest';

suite('ImportProxyCommand Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let i18n: I18nManager;
    let detectStub: sinon.SinonStub;
    let testProxyStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;
    let configUpdateStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        // Force English so we can match action strings deterministically
        i18n.initialize('en');

        detectStub = sandbox.stub(DetectUtils, 'detectSystemProxySettings');
        testProxyStub = sandbox.stub(ConnectionTest, 'testProxyConnection');
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');

        configUpdateStub = sandbox.stub().resolves();
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: configUpdateStub,
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    });

    teardown(() => {
        sandbox.restore();
    });

    interface Notification {
        type: 'success' | 'warning' | 'error' | 'errorWithDetails';
        key: string;
        params?: Record<string, string>;
        suggestions?: string[];
    }

    interface TestContext {
        ctx: CommandContext;
        getState: () => ProxyState;
        applyCalls: Array<{ url: string; enabled: boolean }>;
        notifications: Notification[];
        counters: { monitoringStarts: number; monitoringStops: number; statusBarUpdates: number };
    }

    function createContext(initialState: ProxyState): TestContext {
        let state: ProxyState = { ...initialState };
        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const notifications: Notification[] = [];
        const counters = { monitoringStarts: 0, monitoringStops: 0, statusBarUpdates: 0 };

        const ctx: CommandContext = {
            extensionContext: {} as vscode.ExtensionContext,
            getProxyState: async () => state,
            saveProxyState: async (next) => {
                state = { ...next };
            },
            getActiveProxyUrl: (s) => {
                if (s.mode === ProxyMode.Auto) {
                    return s.autoProxyUrl ?? '';
                }
                if (s.mode === ProxyMode.Manual) {
                    return s.manualProxyUrl ?? '';
                }
                return '';
            },
            getNextMode: (m) => (m === ProxyMode.Manual ? ProxyMode.Auto : ProxyMode.Off),
            applyProxySettings: async (url, enabled) => {
                applyCalls.push({ url, enabled });
                return true;
            },
            updateStatusBar: () => {
                counters.statusBarUpdates++;
            },
            checkAndUpdateSystemProxy: async () => {},
            startSystemProxyMonitoring: async () => {
                counters.monitoringStarts++;
            },
            stopSystemProxyMonitoring: async () => {
                counters.monitoringStops++;
            },
            userNotifier: {
                showSuccess: (key, params) => notifications.push({ type: 'success', key, params }),
                showWarning: (key, params) => notifications.push({ type: 'warning', key, params }),
                showError: (key, suggestions) => notifications.push({ type: 'error', key, suggestions }),
                showErrorWithDetails: async (message, _details, suggestions) => {
                    notifications.push({ type: 'errorWithDetails', key: message, suggestions });
                },
                showProgressNotification: async (_title, task) =>
                    task({ report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>)
            },
            sanitizer: {
                maskPassword: (url) => url.replace(/:([^:@/]+)@/, ':***@')
            }
        };

        return {
            ctx,
            getState: () => state,
            applyCalls,
            notifications,
            counters
        };
    }

    test('no detected proxy + dismissed warning leaves state untouched', async () => {
        detectStub.resolves(null);
        showWarningMessageStub.resolves(undefined);
        const { ctx, getState, applyCalls, notifications } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Off);
        assert.strictEqual(getState().autoProxyUrl, undefined);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(notifications.length, 0);
        sinon.assert.notCalled(executeCommandStub);
        sinon.assert.notCalled(configUpdateStub);
    });

    test('no detected proxy + Configure Manual triggers the configureUrl command', async () => {
        detectStub.resolves(null);
        showWarningMessageStub.resolves(i18n.t('action.configureManual'));
        const { ctx, getState, applyCalls } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        sinon.assert.calledWith(executeCommandStub, 'otak-proxy.configureUrl');
        assert.strictEqual(getState().mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls, []);
    });

    test('no detected proxy + Redetect re-invokes detection', async () => {
        detectStub.resolves(null);
        showWarningMessageStub.onFirstCall().resolves(i18n.t('action.redetect'));
        showWarningMessageStub.onSecondCall().resolves(undefined);
        const { ctx, applyCalls } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        sinon.assert.calledTwice(detectStub);
        sinon.assert.calledTwice(showWarningMessageStub);
        sinon.assert.notCalled(executeCommandStub);
        assert.deepStrictEqual(applyCalls, []);
    });

    test('detected proxy + Cancel leaves state untouched', async () => {
        detectStub.resolves('http://detected.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.cancel'));
        const { ctx, getState, applyCalls, notifications } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.manualProxyUrl, undefined);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(notifications.length, 0);
        sinon.assert.notCalled(configUpdateStub);
        sinon.assert.notCalled(testProxyStub);
    });

    test('detected proxy + Use Auto Mode switches state, applies, and starts monitoring', async () => {
        detectStub.resolves('http://detected.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.useAutoMode'));
        const { ctx, getState, applyCalls, notifications, counters } =
            createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.proxyReachable, undefined);
        assert.strictEqual(state.systemProxyDetected, true);
        assert.deepStrictEqual(applyCalls, [{ url: 'http://detected.example:8080', enabled: true }]);
        assert.strictEqual(counters.monitoringStarts, 1);
        assert.strictEqual(counters.monitoringStops, 0);
        assert.ok(counters.statusBarUpdates >= 1, 'status bar should be refreshed at least once');
        const success = notifications.find(n => n.type === 'success');
        assert.ok(success, 'expected a success notification');
        assert.strictEqual(success?.key, 'message.switchedToAutoMode');
    });

    test('detected proxy + Use Auto Mode clears stale Auto OFF state and restarts monitoring', async () => {
        detectStub.resolves('http://detected.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.useAutoMode'));
        const { ctx, getState, applyCalls, counters } = createContext({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://old.example:8080',
            autoModeOff: true,
            usingFallbackProxy: true,
            fallbackProxyUrl: 'http://fallback.example:3128',
            proxyReachable: false,
            lastTestResult: {
                success: false,
                proxyUrl: 'http://old.example:8080',
                testUrls: ['https://example.com'],
                errors: [{ url: 'https://example.com', message: 'timeout' }],
                timestamp: 1234
            },
            lastTestTimestamp: 1234
        });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        assert.strictEqual(state.proxyReachable, undefined);
        assert.strictEqual(state.lastTestResult, undefined);
        assert.strictEqual(state.lastTestTimestamp, undefined);
        assert.deepStrictEqual(applyCalls, [{ url: 'http://detected.example:8080', enabled: true }]);
        assert.strictEqual(counters.monitoringStops, 1);
        assert.strictEqual(counters.monitoringStarts, 1);
    });

    test('detected proxy + Use Auto Mode with invalid URL surfaces invalidProxyUrlDetected and leaves state untouched', async () => {
        detectStub.resolves('not-a-valid-url');
        showInformationMessageStub.resolves(i18n.t('action.useAutoMode'));
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Off
        });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.monitoringStarts, 0);
        const errorNotif = notifications.find(n => n.type === 'error');
        assert.ok(errorNotif, 'expected an error notification');
        assert.strictEqual(errorNotif?.key, 'error.invalidProxyUrlDetected');
    });

    test('detected proxy + Save as Manual persists state and writes VS Code config', async () => {
        detectStub.resolves('http://detected.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.saveAsManual'));
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Off
        });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.manualProxyUrl, 'http://detected.example:8080');
        // Save-as-Manual should not flip the mode or apply proxy settings directly
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.monitoringStarts, 0);
        sinon.assert.calledOnce(configUpdateStub);
        sinon.assert.calledWith(
            configUpdateStub,
            'proxyUrl',
            'http://detected.example:8080',
            vscode.ConfigurationTarget.Global
        );
        const success = notifications.find(n => n.type === 'success');
        assert.strictEqual(success?.key, 'message.savedAsManualProxy');
    });

    test('detected proxy with credentials + Save as Manual writes credential-stripped URL to settings', async () => {
        detectStub.resolves('http://user:secret@proxy.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.saveAsManual'));
        const { ctx, getState } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        sinon.assert.calledOnce(configUpdateStub);
        const [key, value, target] = configUpdateStub.firstCall.args as [string, string, vscode.ConfigurationTarget];
        assert.strictEqual(key, 'proxyUrl');
        assert.strictEqual(target, vscode.ConfigurationTarget.Global);
        assert.ok(!value.includes('secret'), `password must be stripped, got: ${value}`);
        assert.ok(!value.includes('user'), `username must be stripped, got: ${value}`);
        assert.ok(value.includes('proxy.example'), `host must be preserved, got: ${value}`);
        // Internal state keeps the full URL; only the VS Code setting is stripped
        assert.strictEqual(getState().manualProxyUrl, 'http://user:secret@proxy.example:8080');
    });

    test('detected proxy + Save as Manual with invalid URL surfaces invalidProxyUrlDetected and skips config write', async () => {
        detectStub.resolves('not-a-valid-url');
        showInformationMessageStub.resolves(i18n.t('action.saveAsManual'));
        const { ctx, getState, notifications } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        assert.strictEqual(getState().manualProxyUrl, undefined);
        sinon.assert.notCalled(configUpdateStub);
        const errorNotif = notifications.find(n => n.type === 'error');
        assert.strictEqual(errorNotif?.key, 'error.invalidProxyUrlDetected');
    });

    test('detected proxy + Test First (success) + Use Auto Mode completes Auto switch', async () => {
        detectStub.resolves('http://detected.example:8080');
        testProxyStub.resolves({
            success: true,
            testUrls: ['https://example.com'],
            errors: [],
            proxyUrl: 'http://detected.example:8080',
            timestamp: Date.now()
        });
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.testFirst'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.useAutoMode'));
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Off
        });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.deepStrictEqual(applyCalls, [{ url: 'http://detected.example:8080', enabled: true }]);
        assert.strictEqual(counters.monitoringStarts, 1);
        sinon.assert.calledOnce(testProxyStub);
        const success = notifications.find(n => n.type === 'success');
        assert.strictEqual(success?.key, 'message.switchedToAutoMode');
    });

    test('detected proxy + Test First (success) + Cancel does not change state', async () => {
        detectStub.resolves('http://detected.example:8080');
        testProxyStub.resolves({
            success: true,
            testUrls: ['https://example.com'],
            errors: [],
            proxyUrl: 'http://detected.example:8080',
            timestamp: Date.now()
        });
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.testFirst'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.cancel'));
        const { ctx, getState, applyCalls, counters } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.manualProxyUrl, undefined);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.monitoringStarts, 0);
        sinon.assert.calledOnce(testProxyStub);
        sinon.assert.notCalled(configUpdateStub);
    });

    test('detected proxy + Test First (failure) surfaces showErrorWithDetails and skips state change', async () => {
        detectStub.resolves('http://detected.example:8080');
        testProxyStub.resolves({
            success: false,
            testUrls: ['https://example.com'],
            errors: [{ url: 'https://example.com', message: 'timeout' }],
            proxyUrl: 'http://detected.example:8080',
            timestamp: Date.now()
        });
        showInformationMessageStub.resolves(i18n.t('action.testFirst'));
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Off
        });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.monitoringStarts, 0);
        const detailed = notifications.find(n => n.type === 'errorWithDetails');
        assert.ok(detailed, 'expected errorWithDetails notification');
        assert.strictEqual(detailed?.key, 'error.proxyDoesNotWork');
        sinon.assert.calledOnce(testProxyStub);
    });

    test('detected proxy with credentials shows masked URL in prompt (sanitizer is applied)', async () => {
        detectStub.resolves('http://user:secret@proxy.example:8080');
        showInformationMessageStub.resolves(i18n.t('action.cancel'));
        const { ctx } = createContext({ mode: ProxyMode.Off });

        await executeImportProxy(ctx);

        sinon.assert.calledOnce(showInformationMessageStub);
        const promptText = showInformationMessageStub.firstCall.args[0] as string;
        assert.ok(!promptText.includes('secret'), `password must not appear in prompt, got: ${promptText}`);
        assert.ok(promptText.includes(':***@'), `expected masked marker in prompt, got: ${promptText}`);
    });

    test('detectSystemProxySettings throwing yields failure and reports importProxyFailed', async () => {
        detectStub.rejects(new Error('boom'));
        const { ctx, getState, notifications } = createContext({ mode: ProxyMode.Off });

        const result = await executeImportProxy(ctx);

        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'expected an error to be returned');
        assert.strictEqual(result.error?.message, 'boom');
        assert.strictEqual(getState().mode, ProxyMode.Off);
        const errorNotif = notifications.find(n => n.type === 'error');
        assert.ok(errorNotif, 'expected an error notification');
        assert.strictEqual(errorNotif?.key, 'error.importProxyFailed');
    });
});
