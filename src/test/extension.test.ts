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
        sandbox.stub(vscode.window, 'showInputBox').resolves('http://test-proxy:8080');

        // 設定のモック化
        const mockConfig = {
            get: (key: string) => key === 'proxyUrl' ? 'http://test-proxy:8080' : undefined,
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as vscode.WorkspaceConfiguration;
        
        sandbox.stub(vscode.workspace, 'getConfiguration').returns(mockConfig);

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

    test('Proxy toggle should update state', async () => {
        // The new implementation uses ProxyState with mode field
        await vscode.commands.executeCommand('otak-proxy.toggleProxy');
        const state = globalState.get('proxyState') as any;
        assert.ok(state !== undefined, 'Proxy state should be defined');
    });
});
