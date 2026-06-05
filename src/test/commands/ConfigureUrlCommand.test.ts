import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeConfigureUrl } from '../../commands/ConfigureUrlCommand';
import { CommandContext } from '../../commands/types';
import { ProxyMode, ProxyState } from '../../core/types';
import { I18nManager } from '../../i18n/I18nManager';

suite('ConfigureUrlCommand Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let i18n: I18nManager;
    let showInputBoxStub: sinon.SinonStub;
    let configUpdateStub: sinon.SinonStub;
    let getConfigurationStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        // Force English so any prompt/notification strings are deterministic
        i18n.initialize('en');

        showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
        // The Toggle-side stubs of showWarningMessage are unnecessary here, but other
        // suites may have left vscode.window without these stubs; we don't need them.

        configUpdateStub = sandbox.stub().resolves();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: configUpdateStub,
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);
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

    interface TestHarness {
        ctx: CommandContext;
        getState: () => ProxyState;
        applyCalls: Array<{ url: string; enabled: boolean }>;
        notifications: Notification[];
        counters: { statusBarUpdates: number; saveStateCalls: number };
    }

    function createContext(initialState: ProxyState, overrides?: Partial<CommandContext>): TestHarness {
        let state: ProxyState = { ...initialState };
        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const notifications: Notification[] = [];
        const counters = { statusBarUpdates: 0, saveStateCalls: 0 };

        const ctx: CommandContext = {
            extensionContext: {} as vscode.ExtensionContext,
            getProxyState: async () => state,
            saveProxyState: async (next) => {
                counters.saveStateCalls++;
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
            startSystemProxyMonitoring: async () => {},
            stopSystemProxyMonitoring: async () => {},
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
            },
            ...overrides
        };

        return { ctx, getState: () => state, applyCalls, notifications, counters };
    }

    test('user cancels input box: returns success and leaves state, apply, and config untouched', async () => {
        showInputBoxStub.resolves(undefined);
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://existing.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Manual);
        assert.strictEqual(state.manualProxyUrl, 'http://existing.example:8080');
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.saveStateCalls, 0);
        assert.strictEqual(counters.statusBarUpdates, 0);
        assert.strictEqual(notifications.length, 0);
        sinon.assert.notCalled(configUpdateStub);
    });

    test('initial prompt is pre-filled with the existing manualProxyUrl', async () => {
        showInputBoxStub.resolves(undefined);
        const { ctx } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://existing.example:8080'
        });

        await executeConfigureUrl(ctx);

        sinon.assert.calledOnce(showInputBoxStub);
        const options = showInputBoxStub.firstCall.args[0] as vscode.InputBoxOptions;
        assert.strictEqual(options.value, 'http://existing.example:8080');
    });

    test('initial prompt is pre-filled with empty string when no manualProxyUrl is set', async () => {
        showInputBoxStub.resolves(undefined);
        const { ctx } = createContext({ mode: ProxyMode.Off });

        await executeConfigureUrl(ctx);

        const options = showInputBoxStub.firstCall.args[0] as vscode.InputBoxOptions;
        assert.strictEqual(options.value, '');
    });

    test('invalid URL: shows error-with-details, leaves manualProxyUrl, no apply, no config update', async () => {
        showInputBoxStub.resolves('not-a-valid-url');
        const { ctx, getState, applyCalls, notifications, counters } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://prior.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, false);
        assert.strictEqual(state.manualProxyUrl, 'http://prior.example:8080');
        assert.strictEqual(state.mode, ProxyMode.Manual);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.saveStateCalls, 0);
        assert.strictEqual(counters.statusBarUpdates, 0);
        sinon.assert.notCalled(configUpdateStub);
        const detailed = notifications.find(n => n.type === 'errorWithDetails');
        assert.ok(detailed, 'expected an errorWithDetails notification for the invalid URL');
        assert.strictEqual(detailed?.key, 'error.invalidProxyUrl');
    });

    test('valid URL + Off mode: saves URL to state and config but does not apply or touch status bar', async () => {
        showInputBoxStub.resolves('http://new.example:3128');
        const { ctx, getState, applyCalls, counters } = createContext({ mode: ProxyMode.Off });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.manualProxyUrl, 'http://new.example:3128');
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.statusBarUpdates, 0);
        sinon.assert.calledWith(getConfigurationStub, 'otakProxy');
        sinon.assert.calledOnce(configUpdateStub);
        sinon.assert.calledWith(
            configUpdateStub,
            'proxyUrl',
            'http://new.example:3128',
            vscode.ConfigurationTarget.Global
        );
    });

    test('valid URL + Auto mode: saves URL to state and config but does not apply or change mode', async () => {
        showInputBoxStub.resolves('http://new.example:3128');
        const { ctx, getState, applyCalls, counters } = createContext({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://detected.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.manualProxyUrl, 'http://new.example:3128');
        // Auto-mode auto proxy is untouched
        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.statusBarUpdates, 0);
        sinon.assert.calledOnce(configUpdateStub);
    });

    test('valid URL + Manual mode: saves URL, applies inline with enabled=true, refreshes status bar', async () => {
        showInputBoxStub.resolves('http://new.example:3128');
        const { ctx, getState, applyCalls, counters } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://old.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Manual);
        assert.strictEqual(state.manualProxyUrl, 'http://new.example:3128');
        assert.deepStrictEqual(applyCalls, [{ url: 'http://new.example:3128', enabled: true }]);
        assert.ok(counters.statusBarUpdates >= 1, 'expected status bar to refresh after manual apply');
        sinon.assert.calledOnce(configUpdateStub);
        sinon.assert.calledWith(
            configUpdateStub,
            'proxyUrl',
            'http://new.example:3128',
            vscode.ConfigurationTarget.Global
        );
    });

    test('empty input + Manual mode: drops mode to Off, applies disable, refreshes status bar', async () => {
        showInputBoxStub.resolves('');
        const { ctx, getState, applyCalls, counters } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://old.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        // The save flow records the empty string as the current manual URL
        assert.strictEqual(state.manualProxyUrl, '');
        assert.deepStrictEqual(applyCalls, [{ url: '', enabled: false }]);
        assert.ok(counters.statusBarUpdates >= 1, 'expected status bar refresh after clearing manual proxy');
        // saveProxyState is called twice: once to persist the new (empty) URL, again when switching mode to Off
        assert.strictEqual(counters.saveStateCalls, 2);
        sinon.assert.calledOnce(configUpdateStub);
        sinon.assert.calledWith(
            configUpdateStub,
            'proxyUrl',
            '',
            vscode.ConfigurationTarget.Global
        );
    });

    test('empty input + Off mode: saves empty URL but does not change mode, apply, or status bar', async () => {
        showInputBoxStub.resolves('');
        const { ctx, getState, applyCalls, counters } = createContext({
            mode: ProxyMode.Off,
            manualProxyUrl: 'http://prior.example:8080'
        });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.manualProxyUrl, '');
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.statusBarUpdates, 0);
        assert.strictEqual(counters.saveStateCalls, 1);
        sinon.assert.calledOnce(configUpdateStub);
    });

    test('valid URL with credentials: VS Code config receives credential-stripped value while state keeps full URL', async () => {
        showInputBoxStub.resolves('http://user:secret@proxy.example:8080');
        const { ctx, getState } = createContext({ mode: ProxyMode.Off });

        const result = await executeConfigureUrl(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        // Internal state retains the full URL (including credentials)
        assert.strictEqual(state.manualProxyUrl, 'http://user:secret@proxy.example:8080');

        sinon.assert.calledOnce(configUpdateStub);
        const [key, value, target] = configUpdateStub.firstCall.args as [string, string, vscode.ConfigurationTarget];
        assert.strictEqual(key, 'proxyUrl');
        assert.strictEqual(target, vscode.ConfigurationTarget.Global);
        assert.ok(!value.includes('secret'), `password must be stripped from config value, got: ${value}`);
        assert.ok(!value.includes('user'), `username must be stripped from config value, got: ${value}`);
        assert.ok(value.includes('proxy.example'), `host must be preserved in config value, got: ${value}`);
    });

    test('valid URL with credentials + Manual mode: applyProxySettings receives full URL, config gets stripped URL', async () => {
        showInputBoxStub.resolves('http://user:secret@proxy.example:8080');
        const { ctx, applyCalls } = createContext({
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://old.example:8080'
        });

        const result = await executeConfigureUrl(ctx);

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(applyCalls, [
            { url: 'http://user:secret@proxy.example:8080', enabled: true }
        ]);
        const [, configValue] = configUpdateStub.firstCall.args as [string, string, vscode.ConfigurationTarget];
        assert.ok(!configValue.includes('secret'), `password must not leak into settings, got: ${configValue}`);
    });

    test('error thrown during state read: returns failure and surfaces configureUrlFailed', async () => {
        showInputBoxStub.resolves('http://new.example:3128');
        const { ctx, notifications, applyCalls, counters } = createContext(
            { mode: ProxyMode.Manual },
            {
                getProxyState: async () => {
                    throw new Error('state read boom');
                }
            }
        );

        const result = await executeConfigureUrl(ctx);

        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'expected an error to be returned');
        assert.strictEqual(result.error?.message, 'state read boom');
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual(counters.saveStateCalls, 0);
        sinon.assert.notCalled(showInputBoxStub);
        sinon.assert.notCalled(configUpdateStub);
        const errorNotif = notifications.find(n => n.type === 'error');
        assert.ok(errorNotif, 'expected error notification');
        assert.strictEqual(errorNotif?.key, 'error.configureUrlFailed');
    });

    test('error thrown during applyProxySettings is caught and reported to the user', async () => {
        // Regression guard: handleProxyUrlInput must be awaited so post-input
        // errors stay inside the outer try/catch and surface to the user via
        // 'error.configureUrlFailed' instead of escaping as a rejected promise.
        showInputBoxStub.resolves('http://new.example:3128');
        const { ctx, getState, notifications } = createContext(
            { mode: ProxyMode.Manual, manualProxyUrl: 'http://old.example:8080' },
            {
                applyProxySettings: async () => {
                    throw new Error('apply boom');
                }
            }
        );

        const result = await executeConfigureUrl(ctx);

        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'failure result should carry an error');

        // Save-side effects still happen before the apply throws.
        assert.strictEqual(getState().manualProxyUrl, 'http://new.example:3128');
        sinon.assert.calledOnce(configUpdateStub);

        const errorNotif = notifications.find(n => n.type === 'error');
        assert.ok(errorNotif, 'user must see an error notification');
        assert.strictEqual(errorNotif?.key, 'error.configureUrlFailed');
    });
});
