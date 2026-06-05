import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeToggleShowProxyUrl } from '../../commands/ToggleShowProxyUrlCommand';
import { CommandContext } from '../../commands/types';
import { ProxyMode, ProxyState } from '../../core/types';

suite('ToggleShowProxyUrlCommand Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let configUpdateStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;
    let getConfigurationStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();

        configUpdateStub = sandbox.stub().resolves();
        configGetStub = sandbox.stub();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: configGetStub,
            update: configUpdateStub,
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);
    });

    teardown(() => {
        sandbox.restore();
    });

    interface TestHarness {
        ctx: CommandContext;
        getState: () => ProxyState;
        statusBarCalls: ProxyState[];
        counters: { statusBarUpdates: number; getProxyStateCalls: number };
    }

    function createContext(
        initialState: ProxyState,
        overrides?: Partial<CommandContext>
    ): TestHarness {
        let state: ProxyState = { ...initialState };
        const statusBarCalls: ProxyState[] = [];
        const counters = { statusBarUpdates: 0, getProxyStateCalls: 0 };

        const ctx: CommandContext = {
            extensionContext: {} as vscode.ExtensionContext,
            getProxyState: async () => {
                counters.getProxyStateCalls++;
                return state;
            },
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
            applyProxySettings: async () => true,
            updateStatusBar: (s) => {
                counters.statusBarUpdates++;
                statusBarCalls.push(s);
            },
            checkAndUpdateSystemProxy: async () => {},
            startSystemProxyMonitoring: async () => {},
            stopSystemProxyMonitoring: async () => {},
            userNotifier: {
                showSuccess: () => {},
                showWarning: () => {},
                showError: () => {},
                showErrorWithDetails: async () => {},
                showProgressNotification: async (_title, task) =>
                    task({ report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>)
            },
            sanitizer: {
                maskPassword: (url) => url.replace(/:([^:@/]+)@/, ':***@')
            },
            ...overrides
        };

        return { ctx, getState: () => state, statusBarCalls, counters };
    }

    test('true -> false: writes false to global config, refreshes status bar exactly once with current state', async () => {
        // Current setting is explicitly true; toggle should write false.
        configGetStub.callsFake((key: string, defaultValue?: unknown) =>
            key === 'showProxyUrl' ? true : defaultValue
        );
        const initial: ProxyState = { mode: ProxyMode.Manual, manualProxyUrl: 'http://p.example:8080' };
        const { ctx, statusBarCalls, counters } = createContext(initial);

        const result = await executeToggleShowProxyUrl(ctx);

        assert.deepStrictEqual(result, { success: true });
        sinon.assert.calledWith(getConfigurationStub, 'otakProxy');
        sinon.assert.calledOnce(configUpdateStub);
        // Assert the FULL argument tuple (key, newValue, target) to guard against
        // target-misuse or toggle-direction regressions.
        assert.deepStrictEqual(configUpdateStub.firstCall.args, [
            'showProxyUrl',
            false,
            vscode.ConfigurationTarget.Global
        ]);
        assert.strictEqual(counters.statusBarUpdates, 1);
        assert.strictEqual(counters.getProxyStateCalls, 1);
        // The status bar must be refreshed with the state we obtained from getProxyState.
        assert.strictEqual(statusBarCalls[0].mode, ProxyMode.Manual);
        assert.strictEqual(statusBarCalls[0].manualProxyUrl, 'http://p.example:8080');
    });

    test('false -> true: writes true to global config and refreshes status bar', async () => {
        configGetStub.callsFake((key: string, defaultValue?: unknown) =>
            key === 'showProxyUrl' ? false : defaultValue
        );
        const initial: ProxyState = { mode: ProxyMode.Off };
        const { ctx, statusBarCalls, counters } = createContext(initial);

        const result = await executeToggleShowProxyUrl(ctx);

        assert.deepStrictEqual(result, { success: true });
        sinon.assert.calledOnce(configUpdateStub);
        assert.deepStrictEqual(configUpdateStub.firstCall.args, [
            'showProxyUrl',
            true,
            vscode.ConfigurationTarget.Global
        ]);
        assert.strictEqual(counters.statusBarUpdates, 1);
        assert.strictEqual(statusBarCalls[0].mode, ProxyMode.Off);
    });

    test('unset setting falls back to default (true) and toggles to false', async () => {
        // Simulate VS Code returning the supplied default when the key is unset.
        // The source calls config.get<boolean>('showProxyUrl', true), so the
        // expected effective current value is `true`, and the toggle must yield false.
        configGetStub.callsFake((_key: string, defaultValue?: unknown) => defaultValue);
        const { ctx, counters } = createContext({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });

        const result = await executeToggleShowProxyUrl(ctx);

        assert.deepStrictEqual(result, { success: true });
        sinon.assert.calledOnce(configUpdateStub);
        assert.deepStrictEqual(configUpdateStub.firstCall.args, [
            'showProxyUrl',
            false,
            vscode.ConfigurationTarget.Global
        ]);
        // Sanity: the get call must have requested the right key with default=true.
        const getCall = configGetStub.getCalls().find(c => c.args[0] === 'showProxyUrl');
        assert.ok(getCall, 'showProxyUrl must be read from configuration');
        assert.strictEqual(getCall?.args[1], true, 'default for showProxyUrl must be true');
        assert.strictEqual(counters.statusBarUpdates, 1);
    });

    test('two consecutive toggles flip back to the original value', async () => {
        // First call: setting is true -> writes false. Then we flip the stub so
        // the second call reads false and writes true. This guards against a
        // direction-stuck bug (always writes the same value).
        let current = true;
        configGetStub.callsFake((key: string, defaultValue?: unknown) =>
            key === 'showProxyUrl' ? current : defaultValue
        );
        configUpdateStub.callsFake(async (_key: string, value: boolean) => {
            current = value;
        });
        const { ctx } = createContext({ mode: ProxyMode.Off });

        const first = await executeToggleShowProxyUrl(ctx);
        const second = await executeToggleShowProxyUrl(ctx);

        assert.deepStrictEqual(first, { success: true });
        assert.deepStrictEqual(second, { success: true });
        sinon.assert.calledTwice(configUpdateStub);
        assert.deepStrictEqual(configUpdateStub.firstCall.args, [
            'showProxyUrl',
            false,
            vscode.ConfigurationTarget.Global
        ]);
        assert.deepStrictEqual(configUpdateStub.secondCall.args, [
            'showProxyUrl',
            true,
            vscode.ConfigurationTarget.Global
        ]);
    });

    test('config.update rejection: returns failure with the error and skips status bar refresh', async () => {
        configGetStub.callsFake((_key: string, defaultValue?: unknown) => defaultValue);
        const boom = new Error('update boom');
        configUpdateStub.rejects(boom);
        const { ctx, counters } = createContext({ mode: ProxyMode.Off });

        const result = await executeToggleShowProxyUrl(ctx);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, boom);
        // The update attempt itself still happened, but the post-update side
        // effects (state read + status bar) must NOT fire on the error path.
        sinon.assert.calledOnce(configUpdateStub);
        assert.strictEqual(counters.statusBarUpdates, 0);
        assert.strictEqual(counters.getProxyStateCalls, 0);
    });

    test('getProxyState rejection after successful config write: returns failure, status bar not refreshed', async () => {
        configGetStub.callsFake((key: string, defaultValue?: unknown) =>
            key === 'showProxyUrl' ? true : defaultValue
        );
        const { ctx, counters } = createContext(
            { mode: ProxyMode.Off },
            {
                getProxyState: async () => {
                    throw new Error('state boom');
                }
            }
        );

        const result = await executeToggleShowProxyUrl(ctx);

        assert.strictEqual(result.success, false);
        assert.ok(result.error instanceof Error);
        assert.strictEqual(result.error?.message, 'state boom');
        // Config write happened before the state read, so update is still called once.
        sinon.assert.calledOnce(configUpdateStub);
        assert.deepStrictEqual(configUpdateStub.firstCall.args, [
            'showProxyUrl',
            false,
            vscode.ConfigurationTarget.Global
        ]);
        assert.strictEqual(counters.statusBarUpdates, 0);
    });

    test('non-Error thrown value is normalized to Error in the failure result', async () => {
        configGetStub.callsFake((key: string, defaultValue?: unknown) =>
            key === 'showProxyUrl' ? true : defaultValue
        );
        // Throw a primitive (non-Error) value via a callback we control directly,
        // so we exercise the `error instanceof Error ? error : new Error(String(error))`
        // branch without relying on sinon's coercion of rejects(string).
        const { ctx, counters } = createContext(
            { mode: ProxyMode.Off },
            {
                getProxyState: async () => {
                    // eslint-disable-next-line no-throw-literal
                    throw 'plain string failure';
                }
            }
        );

        const result = await executeToggleShowProxyUrl(ctx);

        assert.strictEqual(result.success, false);
        assert.ok(result.error instanceof Error, 'non-Error thrown values must be wrapped in Error');
        // String(value) must be preserved as the wrapped Error's message.
        assert.strictEqual(result.error?.message, 'plain string failure');
        assert.strictEqual(counters.statusBarUpdates, 0);
    });

    test('reads the otakProxy configuration section (not a sibling section)', async () => {
        // Defensive: a section-name typo would silently read defaults from a
        // non-existent section and the toggle would still "work" but write to
        // the wrong place. Pin the section name.
        configGetStub.callsFake((_key: string, defaultValue?: unknown) => defaultValue);
        const { ctx } = createContext({ mode: ProxyMode.Off });

        await executeToggleShowProxyUrl(ctx);

        sinon.assert.calledWith(getConfigurationStub, 'otakProxy');
        // And the key requested from the config object must be exactly 'showProxyUrl'.
        const getCallKeys = configGetStub.getCalls().map(c => c.args[0]);
        assert.ok(
            getCallKeys.includes('showProxyUrl'),
            `expected showProxyUrl to be read, got keys: ${JSON.stringify(getCallKeys)}`
        );
    });
});
