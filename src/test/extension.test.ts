import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';

suite('Otak Proxy Extension Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let extension: any;
    let globalState: Map<string, any>;
    let mockContext: Partial<vscode.ExtensionContext>;
    let mockStatusBarItem: vscode.StatusBarItem;
    let isFirstTest = true;
    
    setup(async () => {
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
        sandbox.stub(vscode.window, 'createStatusBarItem').returns(mockStatusBarItem);
        sandbox.stub(vscode.window, 'showInformationMessage').resolves('Yes' as any);
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

        // 拡張機能のインポート
        extension = require('../extension');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('Extension should activate', async () => {
        if (isFirstTest) {
            await extension.activate(mockContext);
            isFirstTest = false;
        }
        assert.strictEqual(mockContext.subscriptions!.length > 0, true);
    });

    test('Status bar should be initialized', async () => {
        // Extension already activated in first test
        assert.strictEqual(mockStatusBarItem.command, 'otak-proxy.toggleProxy');
    });

    test('Initial setup should be prompted on first activation', async () => {
        // Extension already activated in first test
        const showInputBox = vscode.window.showInputBox as sinon.SinonStub;
        assert.strictEqual(showInputBox.called, true);
        assert.strictEqual(globalState.get('hasInitialSetup'), true);
    });

    test('Proxy toggle should update state', async () => {
        // Extension already activated in first test
        await vscode.commands.executeCommand('otak-proxy.toggleProxy');
        assert.strictEqual(globalState.get('proxyEnabled'), true);
    });
});
