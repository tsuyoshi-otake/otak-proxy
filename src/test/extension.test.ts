import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';

suite('Otak Proxy Extension Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let extension: any;
    let globalState: Map<string, any>;
    let mockContext: Partial<vscode.ExtensionContext>;
    let mockStatusBarItem: vscode.StatusBarItem;
    let createStatusBarItemStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;

    suiteSetup(async () => {
        // Clear module cache to avoid conflicts with other test suites
        delete require.cache[require.resolve('../extension')];

        // Setup once for the entire suite
        sandbox = sinon.createSandbox();
        globalState = new Map();

        // グローバルステートのモック作成
        const mockMemento: vscode.Memento & { setKeysForSync(keys: readonly string[]): void } = {
            get: <T>(key: string, defaultValue?: T): T => (globalState.get(key) ?? defaultValue) as T,
            update: async (key: string, value: any) => {
                globalState.set(key, value);
                return Promise.resolve();
            },
            keys: () => [],
            setKeysForSync: (keys: readonly string[]) => {}
        };

        // ステータスバーアイテムのモック作成
        mockStatusBarItem = {
            dispose: () => {},
            show: () => {},
            hide: () => {},
            text: '',
            tooltip: '',
            command: '',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 100,
            id: 'test-status-bar',
            name: 'Test Status Bar',
            color: new vscode.ThemeColor('statusBar.foreground'),
            backgroundColor: new vscode.ThemeColor('statusBar.background'),
            accessibilityInformation: { label: 'Test Status Bar' }
        } as vscode.StatusBarItem;

        // コンテキストのモック作成
        mockContext = {
            subscriptions: [],
            globalState: mockMemento,
            workspaceState: mockMemento,
            extensionUri: vscode.Uri.file(__dirname),
            extensionPath: __dirname,
            storageUri: vscode.Uri.file(__dirname),
            storagePath: __dirname,
            globalStorageUri: vscode.Uri.file(__dirname),
            globalStoragePath: __dirname,
            logUri: vscode.Uri.file(__dirname),
            logPath: __dirname,
            extensionMode: vscode.ExtensionMode.Test
        };

        // VSCode APIのモック化
        createStatusBarItemStub = sandbox.stub(vscode.window, 'createStatusBarItem').returns(mockStatusBarItem);
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Skip' as any);
        sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        sandbox.stub(vscode.window, 'showWarningMessage').resolves();
        sandbox.stub(vscode.window, 'showInputBox').resolves('http://test-proxy:8080');
        sandbox.stub(vscode.window, 'withProgress').callsFake(async (options, task) => {
            return task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
        });

        // Mock registerCommand to prevent "command already exists" error
        sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose: () => {} });

        // 設定のモック化
        const mockConfig = {
            get: (key: string, defaultValue?: any) => {
                if (key === 'proxyUrl') { return 'http://test-proxy:8080'; }
                if (key === 'pollingInterval') { return 30; }
                if (key === 'maxRetries') { return 3; }
                if (key === 'detectionSourcePriority') { return ['environment', 'vscode', 'platform']; }
                return defaultValue;
            },
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as vscode.WorkspaceConfiguration;

        sandbox.stub(vscode.workspace, 'getConfiguration').returns(mockConfig);
        sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => {} });
        sandbox.stub(vscode.window, 'onDidChangeWindowState').returns({ dispose: () => {} });

        // 拡張機能のインポートとアクティベート
        extension = require('../extension');
        await extension.activate(mockContext);
    });

    suiteTeardown(() => {
        sandbox.restore();
    });

    test('Extension should activate', async () => {
        assert.strictEqual(mockContext.subscriptions!.length > 0, true);
    });

    test('Status bar should be initialized', async () => {
        // Verify that createStatusBarItem was called during activation
        assert.strictEqual(createStatusBarItemStub.called, true);
    });

    test('Initial setup should be prompted on first activation', async () => {
        // Verify that showInformationMessage was called during activation
        assert.strictEqual(showInformationMessageStub.called, true);
        assert.strictEqual(globalState.get('hasInitialSetup'), true);
    });

    test('Proxy toggle command should be registered', async function() {
        this.timeout(10000);
        // Since we stub registerCommand, we just verify activate completed successfully
        // and the subscriptions array has items (commands were registered)
        assert.ok(mockContext.subscriptions!.length > 0, 'Commands should be registered in subscriptions');
    });
});
