import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ExtensionInitializer } from '../core/ExtensionInitializer';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<'timeout' | 'settled'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    return Promise.race([
        promise.then(() => 'settled' as const),
        timeout
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

function createStatusBarItem(): vscode.StatusBarItem {
    return {
        dispose: () => {},
        show: () => {},
        hide: () => {},
        text: '',
        tooltip: '',
        command: '',
        alignment: vscode.StatusBarAlignment.Left,
        priority: 100,
        id: 'test-status-bar',
        name: 'Test Status Bar',
        color: new vscode.ThemeColor('statusBar.foreground'),
        backgroundColor: new vscode.ThemeColor('statusBar.background'),
        accessibilityInformation: { label: 'Test Status Bar' }
    } as vscode.StatusBarItem;
}

function createMemento(store: Map<string, unknown>): vscode.Memento & { setKeysForSync(keys: readonly string[]): void } {
    return {
        get: <T>(key: string, defaultValue?: T): T => (store.get(key) ?? defaultValue) as T,
        update: async (key: string, value: unknown) => {
            store.set(key, value);
        },
        keys: () => [...store.keys()],
        setKeysForSync: () => {}
    };
}

suite('Extension activation with first-run setup', () => {
    let sandbox: sinon.SinonSandbox;
    let extension: {
        activate: (context: vscode.ExtensionContext) => Promise<void>;
        deactivate?: () => Promise<void>;
        performInitialSetup: (context: vscode.ExtensionContext) => Promise<boolean>;
        whenInitialSetupCompleted?: () => Promise<void>;
        whenStartupProxyApplied?: () => Promise<void>;
    };
    let resolveInitialPrompt: ((value: string | undefined) => void) | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        delete require.cache[require.resolve('../extension')];
        extension = require('../extension');
        resolveInitialPrompt = undefined;
    });

    teardown(async () => {
        resolveInitialPrompt?.(undefined);
        await extension.whenInitialSetupCompleted?.();
        await extension.whenStartupProxyApplied?.();
        await extension.deactivate?.();
        sandbox.restore();
        delete require.cache[require.resolve('../extension')];
    });

    test('activate resolves and registers commands while the initial setup prompt is unanswered', async () => {
        const globalStore = new Map<string, unknown>();
        const workspaceStore = new Map<string, unknown>();
        const registeredCommands: string[] = [];

        const globalState = createMemento(globalStore);
        const workspaceState = createMemento(workspaceStore);
        const mockContext = {
            subscriptions: [],
            globalState,
            workspaceState,
            extensionUri: vscode.Uri.file(__dirname),
            extensionPath: __dirname,
            storageUri: vscode.Uri.file(__dirname),
            storagePath: __dirname,
            globalStorageUri: vscode.Uri.file(__dirname),
            globalStoragePath: __dirname,
            logUri: vscode.Uri.file(__dirname),
            logPath: __dirname,
            extensionMode: vscode.ExtensionMode.Test
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, 'createStatusBarItem').returns(createStatusBarItem());
        sandbox.stub(vscode.window, 'showInformationMessage').callsFake((() => new Promise(resolve => {
            resolveInitialPrompt = resolve as (value: string | undefined) => void;
        })) as typeof vscode.window.showInformationMessage);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
        sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, task) => {
            return task(
                { report: () => {} },
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
            );
        });
        sandbox.stub(vscode.commands, 'registerCommand').callsFake((commandId: string) => {
            registeredCommands.push(commandId);
            return { dispose: () => {} };
        });
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'detectionSourcePriority') {
                    return ['environment', 'vscode', 'platform'];
                }
                return defaultValue;
            },
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => {} });
        sandbox.stub(vscode.window, 'onDidChangeWindowState').returns({ dispose: () => {} });

        const result = await withTimeout(extension.activate(mockContext), 2000);

        assert.strictEqual(result, 'settled', 'activate must not wait for the first-run setup prompt');
        assert.ok(
            registeredCommands.includes('otak-proxy.toggleProxy'),
            `toggle command should be registered before setup prompt settles: ${registeredCommands.join(', ')}`
        );
        assert.strictEqual(globalStore.get('hasInitialSetup'), undefined);
    });

    function stubVscodeApiAndCreateContext(globalStore: Map<string, unknown>): vscode.ExtensionContext {
        const globalState = createMemento(globalStore);
        const workspaceState = createMemento(new Map<string, unknown>());
        const mockContext = {
            subscriptions: [],
            globalState,
            workspaceState,
            extensionUri: vscode.Uri.file(__dirname),
            extensionPath: __dirname,
            storageUri: vscode.Uri.file(__dirname),
            storagePath: __dirname,
            globalStorageUri: vscode.Uri.file(__dirname),
            globalStoragePath: __dirname,
            logUri: vscode.Uri.file(__dirname),
            logPath: __dirname,
            extensionMode: vscode.ExtensionMode.Test
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, 'createStatusBarItem').returns(createStatusBarItem());
        sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
        sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, task) => {
            return task(
                { report: () => {} },
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
            );
        });
        sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose: () => {} });
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => {} });
        sandbox.stub(vscode.window, 'onDidChangeWindowState').returns({ dispose: () => {} });

        return mockContext;
    }

    test('an unsaved setup answer leaves hasInitialSetup unset and performInitialSetup returns false', async () => {
        const globalStore = new Map<string, unknown>();
        const mockContext = stubVscodeApiAndCreateContext(globalStore);
        // The commit for the user's answer loses every CAS attempt: the flow
        // reports the answer could not be saved.
        sandbox.stub(ExtensionInitializer.prototype, 'askForInitialSetup').resolves(false);

        await extension.activate(mockContext);
        await extension.whenInitialSetupCompleted?.();

        assert.strictEqual(globalStore.get('hasInitialSetup'), undefined,
            'an answer that could not be saved must not mark the setup done');
        const ran = await extension.performInitialSetup(mockContext);
        assert.strictEqual(ran, false, 'performInitialSetup reports the unsaved setup');
        assert.strictEqual(globalStore.get('hasInitialSetup'), undefined,
            'the prompt is offered again on the next activation');
    });

    test('a finished setup sets hasInitialSetup', async () => {
        const globalStore = new Map<string, unknown>();
        const mockContext = stubVscodeApiAndCreateContext(globalStore);
        sandbox.stub(ExtensionInitializer.prototype, 'askForInitialSetup').resolves(true);

        await extension.activate(mockContext);
        await extension.whenInitialSetupCompleted?.();

        assert.strictEqual(globalStore.get('hasInitialSetup'), true);
    });
});
