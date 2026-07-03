import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    CommandRegistry,
    CommandRegistryConfig,
    createCommandRegistry
} from '../../commands/CommandRegistry';
import { ProxyMode, ProxyState } from '../../core/types';

const EXPECTED_COMMANDS = [
    'otak-proxy.toggleProxy',
    'otak-proxy.configureUrl',
    'otak-proxy.testProxy',
    'otak-proxy.importProxy',
    'otak-proxy.toggleShowProxyUrl',
    'otak-proxy.diagnoseProxy',
    'otak-proxy.resetWinHttpProxy'
];

suite('CommandRegistry Smoke Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let registerCommandStub: sinon.SinonStub;
    let configListenerStub: sinon.SinonStub;
    let windowStateListenerStub: sinon.SinonStub;
    let extensionContext: vscode.ExtensionContext;
    let baseConfig: CommandRegistryConfig;

    setup(() => {
        sandbox = sinon.createSandbox();
        registerCommandStub = sandbox.stub(vscode.commands, 'registerCommand')
            .returns({ dispose: () => {} } as vscode.Disposable);
        configListenerStub = sandbox.stub(vscode.workspace, 'onDidChangeConfiguration')
            .returns({ dispose: () => {} } as vscode.Disposable);
        windowStateListenerStub = sandbox.stub(vscode.window, 'onDidChangeWindowState')
            .returns({ dispose: () => {} } as vscode.Disposable);

        extensionContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        baseConfig = {
            context: extensionContext,
            getProxyState: async () => ({ mode: ProxyMode.Off } as ProxyState),
            saveProxyState: async () => {},
            getActiveProxyUrl: () => '',
            getNextMode: () => ProxyMode.Off,
            applyProxySettings: async () => true,
            updateStatusBar: () => {},
            checkAndUpdateSystemProxy: async () => {},
            startSystemProxyMonitoring: async () => {},
            stopSystemProxyMonitoring: async () => {},
            userNotifier: {
                showSuccess: () => {},
                showWarning: () => {},
                showError: () => {},
                showErrorWithDetails: async () => {},
                showProgressNotification: async (_title, task) => task({ report: () => {} })
            },
            sanitizer: {
                maskPassword: (url: string) => url
            },
            proxyMonitor: {
                updateConfig: () => {},
                triggerCheck: () => {}
            },
            systemProxyDetector: {
                updateDetectionPriority: () => {}
            }
        };
    });

    teardown(() => {
        sandbox.restore();
    });

    test('registerAll registers every contributed command exactly once', () => {
        const registry = new CommandRegistry(baseConfig);
        registry.registerAll();

        const registeredKeys = registerCommandStub.getCalls().map(call => call.args[0]);
        for (const key of EXPECTED_COMMANDS) {
            assert.ok(
                registeredKeys.includes(key),
                `Expected command "${key}" to be registered. Got: ${registeredKeys.join(', ')}`
            );
        }
        // Each command is registered once; duplicates would break VS Code's command palette.
        const uniqueKeys = new Set(registeredKeys);
        assert.strictEqual(uniqueKeys.size, registeredKeys.length, 'Commands should not be registered twice');
    });

    test('registerAll wires the configuration- and window-state listeners', () => {
        const registry = new CommandRegistry(baseConfig);
        registry.registerAll();

        sinon.assert.calledOnce(configListenerStub);
        sinon.assert.calledOnce(windowStateListenerStub);
    });

    test('registerAll pushes every disposable into extensionContext.subscriptions', () => {
        const registry = new CommandRegistry(baseConfig);
        registry.registerAll();

        // Contributed commands + 1 config-change listener + 1 window-state listener
        assert.strictEqual(
            extensionContext.subscriptions.length,
            EXPECTED_COMMANDS.length + 2,
            `Expected ${EXPECTED_COMMANDS.length + 2} disposables, got ${extensionContext.subscriptions.length}`
        );
    });

    test('createCommandRegistry helper performs registration as a single step', () => {
        const registry = createCommandRegistry(baseConfig);

        assert.ok(registry instanceof CommandRegistry, 'Helper should return a CommandRegistry instance');
        const registeredKeys = registerCommandStub.getCalls().map(call => call.args[0]);
        for (const key of EXPECTED_COMMANDS) {
            assert.ok(registeredKeys.includes(key));
        }
    });

    test('config-change callback: otakProxy.proxyUrl in Manual mode saves state, strips credentials, applies, refreshes', async () => {
        // Simulates a user editing otakProxy.proxyUrl while in Manual mode.
        // The callback should: persist state (full URL), write the credential-stripped
        // URL back into the workspace config, re-apply proxy settings, and refresh
        // the status bar.
        let savedState: ProxyState | undefined;
        let applyArgs: { url: string; enabled: boolean } | undefined;
        let statusBarUpdates = 0;
        const configUpdates: Array<{ key: string; value: unknown }> = [];

        const config: CommandRegistryConfig = {
            ...baseConfig,
            getProxyState: async () =>
                ({ mode: ProxyMode.Manual, manualProxyUrl: 'http://old.example:8080' } as ProxyState),
            saveProxyState: async (_ctx, next) => { savedState = next; },
            applyProxySettings: async (url, enabled) => {
                applyArgs = { url, enabled };
                return true;
            },
            updateStatusBar: () => { statusBarUpdates++; }
        };

        const getConfigStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string) =>
                key === 'proxyUrl' ? 'http://user:pass@new.example:3128' : undefined,
            update: async (key: string, value: unknown) => {
                configUpdates.push({ key, value });
            },
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        new CommandRegistry(config).registerAll();
        const cb = configListenerStub.firstCall.args[0] as (
            e: vscode.ConfigurationChangeEvent
        ) => Promise<void>;

        await cb({ affectsConfiguration: (k: string) => k === 'otakProxy.proxyUrl' } as
            vscode.ConfigurationChangeEvent);

        assert.strictEqual(savedState?.manualProxyUrl, 'http://user:pass@new.example:3128',
            'state must keep the full URL with credentials');
        assert.deepStrictEqual(applyArgs, { url: 'http://user:pass@new.example:3128', enabled: true },
            'apply must receive the credentialed URL in Manual mode');
        assert.strictEqual(statusBarUpdates, 1, 'status bar must refresh once');

        const proxyUrlUpdate = configUpdates.find(u => u.key === 'proxyUrl');
        assert.ok(proxyUrlUpdate, 'workspace config must be rewritten');
        // removeProxyCredentials round-trips through URL, which appends a trailing slash.
        assert.strictEqual(proxyUrlUpdate?.value, 'http://new.example:3128/',
            'config must store the credential-stripped URL');

        sinon.assert.calledWith(getConfigStub, 'otakProxy');
    });

    test('config-change callback: otakProxy.showProxyUrl refreshes the status bar', async () => {
        let statusBarUpdates = 0;
        const config: CommandRegistryConfig = {
            ...baseConfig,
            getProxyState: async () => ({ mode: ProxyMode.Off } as ProxyState),
            updateStatusBar: () => { statusBarUpdates++; }
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => undefined,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);

        new CommandRegistry(config).registerAll();
        const cb = configListenerStub.firstCall.args[0] as (
            e: vscode.ConfigurationChangeEvent
        ) => Promise<void>;

        await cb({ affectsConfiguration: (k: string) => k === 'otakProxy.showProxyUrl' } as
            vscode.ConfigurationChangeEvent);

        assert.strictEqual(statusBarUpdates, 1);
    });

    test('package.json contributed commands list matches what is registered', () => {
        // Guard against drift between package.json contributes.commands and the registry.
        // If a new command is added to package.json, this test forces the maintainer to
        // either register it here or to update EXPECTED_COMMANDS.
        const pkg = require('../../../package.json') as {
            contributes?: { commands?: Array<{ command: string }> };
        };
        const declared = (pkg.contributes?.commands ?? []).map(c => c.command);
        const declaredSet = new Set(declared);
        const expectedSet = new Set(EXPECTED_COMMANDS);

        assert.deepStrictEqual(
            [...declaredSet].sort(),
            [...expectedSet].sort(),
            'EXPECTED_COMMANDS must mirror package.json contributes.commands'
        );
    });
});
