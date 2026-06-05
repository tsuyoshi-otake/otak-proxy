import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { InitialSetupFlow } from '../../core/InitialSetupFlow';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState } from '../../core/types';
import { I18nManager } from '../../i18n/I18nManager';
import * as DetectUtils from '../../utils/SystemProxyDetectionUtils';

interface RecordedApplyCall {
    url: string;
    enabled: boolean;
}

interface RecordedNotification {
    type: 'success' | 'warning' | 'error';
    key: string;
    params?: Record<string, string>;
    suggestions?: string[];
}

suite('InitialSetupFlow Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let i18n: I18nManager;

    let state: ProxyState;
    let saveStateStub: sinon.SinonStub;
    let getStateStub: sinon.SinonStub;
    let applyProxyStub: sinon.SinonStub;
    let showSuccessStub: sinon.SinonStub;
    let showErrorStub: sinon.SinonStub;
    let showWarningStub: sinon.SinonStub;

    let showInformationMessageStub: sinon.SinonStub;
    let showInputBoxStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    let getConfigurationStub: sinon.SinonStub;
    let configUpdateStub: sinon.SinonStub;
    let detectStub: sinon.SinonStub;

    let startSystemProxyMonitoringStub: sinon.SinonStub;

    let context: InitializerContext;
    let flow: InitialSetupFlow;

    const recordedApplyCalls: RecordedApplyCall[] = [];
    const recordedNotifications: RecordedNotification[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        // Force English so the action label string comparisons are deterministic.
        i18n.initialize('en');

        recordedApplyCalls.length = 0;
        recordedNotifications.length = 0;

        state = { mode: ProxyMode.Off };

        saveStateStub = sandbox.stub().callsFake(async (next: ProxyState) => {
            state = { ...next };
        });
        getStateStub = sandbox.stub().callsFake(async () => ({ ...state }));
        applyProxyStub = sandbox.stub().callsFake(async (url: string, enabled: boolean) => {
            recordedApplyCalls.push({ url, enabled });
            return true;
        });

        showSuccessStub = sandbox.stub().callsFake((key: string, params?: Record<string, string>) => {
            recordedNotifications.push({ type: 'success', key, params });
        });
        showWarningStub = sandbox.stub().callsFake((key: string, params?: Record<string, string>) => {
            recordedNotifications.push({ type: 'warning', key, params });
        });
        showErrorStub = sandbox.stub().callsFake((key: string, suggestions?: string[]) => {
            recordedNotifications.push({ type: 'error', key, suggestions });
        });

        detectStub = sandbox.stub(DetectUtils, 'detectSystemProxySettings');
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
        showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
        executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();

        configUpdateStub = sandbox.stub().resolves();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: configUpdateStub,
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        startSystemProxyMonitoringStub = sandbox.stub().resolves();

        context = {
            extensionContext: {} as vscode.ExtensionContext,
            proxyStateManager: {
                getState: getStateStub,
                saveState: saveStateStub
            } as unknown as InitializerContext['proxyStateManager'],
            proxyApplier: {
                applyProxy: applyProxyStub
            } as unknown as InitializerContext['proxyApplier'],
            systemProxyDetector: {} as unknown as InitializerContext['systemProxyDetector'],
            userNotifier: {
                showSuccess: showSuccessStub,
                showError: showErrorStub,
                showWarning: showWarningStub
            } as unknown as InitializerContext['userNotifier'],
            sanitizer: {
                maskPassword: (url: string) => url.replace(/:([^:@/]+)@/, ':****@')
            } as unknown as InitializerContext['sanitizer'],
            proxyChangeLogger: {} as unknown as InitializerContext['proxyChangeLogger']
        };

        flow = new InitialSetupFlow(context, startSystemProxyMonitoringStub);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('user dismisses initial prompt (state stays Off): no detection, no apply, no monitoring', async () => {
        state = { mode: ProxyMode.Off };
        showInformationMessageStub.resolves(undefined);

        await flow.askForInitialSetup();

        sinon.assert.notCalled(detectStub);
        sinon.assert.notCalled(showInputBoxStub);
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
        sinon.assert.notCalled(configUpdateStub);
        assert.strictEqual(recordedNotifications.length, 0);
        assert.strictEqual(state.mode, ProxyMode.Off);
    });

    test('user picks Skip while initial state is Auto: re-starts system proxy monitoring without touching state', async () => {
        // Edge case: the post-block at the end of askForInitialSetup re-arms monitoring
        // whenever the persisted mode is already Auto, even if the user dismissed setup.
        state = { mode: ProxyMode.Auto, autoProxyUrl: 'http://prior.example:8080' };
        showInformationMessageStub.resolves(i18n.t('action.skip'));

        await flow.askForInitialSetup();

        sinon.assert.notCalled(detectStub);
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.calledOnce(startSystemProxyMonitoringStub);
        // Persisted state untouched
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://prior.example:8080');
    });

    test('Auto + valid detected proxy: saves Auto state, applies, notifies usingSystemProxy, starts monitoring', async () => {
        showInformationMessageStub.resolves(i18n.t('action.autoSystem'));
        detectStub.resolves('http://detected.example:8080');

        await flow.askForInitialSetup();

        sinon.assert.calledOnce(saveStateStub);
        const saved = saveStateStub.firstCall.args[0] as ProxyState;
        assert.strictEqual(saved.mode, ProxyMode.Auto);
        assert.strictEqual(saved.autoProxyUrl, 'http://detected.example:8080');

        assert.deepStrictEqual(recordedApplyCalls, [
            { url: 'http://detected.example:8080', enabled: true }
        ]);
        const success = recordedNotifications.find(n => n.type === 'success');
        assert.ok(success, 'expected a success notification');
        assert.strictEqual(success?.key, 'message.usingSystemProxy');
        assert.strictEqual(success?.params?.url, 'http://detected.example:8080');

        // The fallback prompt must NOT be shown when detection succeeded
        sinon.assert.calledOnce(showInformationMessageStub);
        sinon.assert.notCalled(executeCommandStub);
        sinon.assert.calledOnce(startSystemProxyMonitoringStub);
    });

    test('Auto + detected proxy with credentials: maskPassword is used in the success notification', async () => {
        showInformationMessageStub.resolves(i18n.t('action.autoSystem'));
        detectStub.resolves('http://user:secret@proxy.example:8080');

        await flow.askForInitialSetup();

        const success = recordedNotifications.find(n => n.type === 'success');
        assert.ok(success, 'expected a success notification');
        const urlParam = success?.params?.url ?? '';
        assert.ok(!urlParam.includes('secret'), `password must be masked, got: ${urlParam}`);
        assert.ok(urlParam.includes('****'), `expected mask marker in notification, got: ${urlParam}`);

        // applyProxy still receives the full URL (credentials intact)
        assert.deepStrictEqual(recordedApplyCalls, [
            { url: 'http://user:secret@proxy.example:8080', enabled: true }
        ]);
    });

    test('Auto + detection null + fallback "No": no apply, no monitoring, no notifications', async () => {
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.autoSystem'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.no'));
        detectStub.resolves(null);

        await flow.askForInitialSetup();

        sinon.assert.calledTwice(showInformationMessageStub);
        sinon.assert.notCalled(executeCommandStub);
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
        assert.strictEqual(recordedNotifications.length, 0);
        assert.strictEqual(state.mode, ProxyMode.Off);
    });

    test('Auto + detected URL invalid: triggers the "could not detect" fallback prompt (treated as no detection)', async () => {
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.autoSystem'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.no'));
        // detectSystemProxySettings normally filters invalid URLs, but if it leaks
        // one, validateProxyUrl in InitialSetupFlow must catch it.
        detectStub.resolves('not-a-valid-url');

        await flow.askForInitialSetup();

        // Should bypass the success path entirely
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        // Second prompt is the fallback prompt
        sinon.assert.calledTwice(showInformationMessageStub);
        const fallbackPromptText = showInformationMessageStub.secondCall.args[0] as string;
        assert.strictEqual(fallbackPromptText, i18n.t('prompt.couldNotDetect'));
    });

    test('Auto + detection null + fallback "Yes" + configureUrl persists manual URL: switches to Manual, applies', async () => {
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.autoSystem'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.yes'));
        detectStub.resolves(null);

        // Simulate the configureUrl command persisting a manual proxy URL.
        executeCommandStub.callsFake(async (cmd: string) => {
            if (cmd === 'otak-proxy.configureUrl') {
                state = { ...state, manualProxyUrl: 'http://manual.example:3128' };
            }
            return undefined;
        });

        await flow.askForInitialSetup();

        sinon.assert.calledWith(executeCommandStub, 'otak-proxy.configureUrl');
        sinon.assert.calledOnce(saveStateStub);
        const saved = saveStateStub.firstCall.args[0] as ProxyState;
        assert.strictEqual(saved.mode, ProxyMode.Manual);
        assert.strictEqual(saved.manualProxyUrl, 'http://manual.example:3128');
        assert.deepStrictEqual(recordedApplyCalls, [
            { url: 'http://manual.example:3128', enabled: true }
        ]);
        // The outer `state` local in askForInitialSetup is still Off (only the
        // fallback's updatedState was mutated), so monitoring should NOT start.
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
    });

    test('Auto + detection null + fallback "Yes" but configureUrl does not persist a manual URL: no save, no apply', async () => {
        showInformationMessageStub.onFirstCall().resolves(i18n.t('action.autoSystem'));
        showInformationMessageStub.onSecondCall().resolves(i18n.t('action.yes'));
        detectStub.resolves(null);
        // executeCommandStub default is resolves() — state.manualProxyUrl stays undefined

        await flow.askForInitialSetup();

        sinon.assert.calledWith(executeCommandStub, 'otak-proxy.configureUrl');
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
    });

    test('Manual + user cancels input box: no save, no apply, no config update', async () => {
        showInformationMessageStub.resolves(i18n.t('action.manualSetup'));
        showInputBoxStub.resolves(undefined);

        await flow.askForInitialSetup();

        sinon.assert.calledOnce(showInputBoxStub);
        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(configUpdateStub);
        assert.strictEqual(recordedNotifications.length, 0);
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
    });

    test('Manual + empty input: short-circuits exactly like a cancel', async () => {
        showInformationMessageStub.resolves(i18n.t('action.manualSetup'));
        showInputBoxStub.resolves('');

        await flow.askForInitialSetup();

        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(configUpdateStub);
        assert.strictEqual(recordedNotifications.length, 0);
    });

    test('Manual + invalid URL: shows error with suggestions and does not save/apply/write config', async () => {
        showInformationMessageStub.resolves(i18n.t('action.manualSetup'));
        showInputBoxStub.resolves('not-a-valid-url');

        await flow.askForInitialSetup();

        sinon.assert.notCalled(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(configUpdateStub);
        const errorNotif = recordedNotifications.find(n => n.type === 'error');
        assert.ok(errorNotif, 'expected error notification for invalid URL');
        assert.strictEqual(errorNotif?.key, 'error.invalidProxyUrl');
        assert.deepStrictEqual(errorNotif?.suggestions, [
            'suggestion.useFormat',
            'suggestion.includeProtocol',
            'suggestion.validHostname'
        ]);
    });

    test('Manual + valid URL: saves Manual state, writes VS Code config, applies, notifies manualProxyConfigured', async () => {
        showInformationMessageStub.resolves(i18n.t('action.manualSetup'));
        showInputBoxStub.resolves('http://manual.example:3128');

        await flow.askForInitialSetup();

        sinon.assert.calledOnce(saveStateStub);
        const saved = saveStateStub.firstCall.args[0] as ProxyState;
        assert.strictEqual(saved.mode, ProxyMode.Manual);
        assert.strictEqual(saved.manualProxyUrl, 'http://manual.example:3128');

        sinon.assert.calledWith(getConfigurationStub, 'otakProxy');
        sinon.assert.calledOnce(configUpdateStub);
        sinon.assert.calledWith(
            configUpdateStub,
            'proxyUrl',
            'http://manual.example:3128',
            vscode.ConfigurationTarget.Global
        );

        assert.deepStrictEqual(recordedApplyCalls, [
            { url: 'http://manual.example:3128', enabled: true }
        ]);
        const success = recordedNotifications.find(n => n.type === 'success');
        assert.ok(success, 'expected success notification');
        assert.strictEqual(success?.key, 'message.manualProxyConfigured');
        assert.strictEqual(success?.params?.url, 'http://manual.example:3128');

        // Manual mode must NOT start system proxy monitoring.
        sinon.assert.notCalled(startSystemProxyMonitoringStub);
    });

    test('Manual + valid URL with credentials: VS Code config gets credential-stripped URL, apply receives the full URL', async () => {
        showInformationMessageStub.resolves(i18n.t('action.manualSetup'));
        showInputBoxStub.resolves('http://user:secret@proxy.example:8080');

        await flow.askForInitialSetup();

        sinon.assert.calledOnce(configUpdateStub);
        const [key, value, target] = configUpdateStub.firstCall.args as [
            string,
            string,
            vscode.ConfigurationTarget
        ];
        assert.strictEqual(key, 'proxyUrl');
        assert.strictEqual(target, vscode.ConfigurationTarget.Global);
        assert.ok(!value.includes('secret'), `password must be stripped from config value, got: ${value}`);
        assert.ok(!value.includes('user'), `username must be stripped from config value, got: ${value}`);
        assert.ok(value.includes('proxy.example'), `host must survive in config value, got: ${value}`);

        // applyProxy receives the full URL (with credentials) so the proxy can authenticate.
        assert.deepStrictEqual(recordedApplyCalls, [
            { url: 'http://user:secret@proxy.example:8080', enabled: true }
        ]);

        // The success notification uses the masked URL via sanitizer.maskPassword.
        const success = recordedNotifications.find(n => n.type === 'success');
        const notifiedUrl = success?.params?.url ?? '';
        assert.ok(!notifiedUrl.includes('secret'), `password must be masked in notification, got: ${notifiedUrl}`);
    });
});
