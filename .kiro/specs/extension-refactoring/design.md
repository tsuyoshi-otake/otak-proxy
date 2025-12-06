# Design Document

## Overview

このドキュメントは、otak-proxy拡張機能のextension.ts（1335行）を、保守性と可読性を向上させるために複数の小さなモジュールに分割するリファクタリングの設計を定義します。

現在の問題点：
- 単一ファイルが1335行と大きすぎる
- コマンド、状態管理、UI更新、設定適用が混在
- 重複コードが多数存在（特にimportProxyコマンド内）
- テストが遅い（外部コマンド依存、高い実行回数）

## Architecture

### 新しいフォルダ構造

```
src/
├── extension.ts (エントリーポイント、100行程度)
├── core/
│   ├── ProxyStateManager.ts (状態管理)
│   ├── ProxyApplier.ts (設定適用ロジック)
│   └── types.ts (共通型定義)
├── commands/
│   ├── CommandRegistry.ts (コマンド登録)
│   ├── ToggleProxyCommand.ts
│   ├── ConfigureUrlCommand.ts
│   ├── TestProxyCommand.ts
│   └── ImportProxyCommand.ts
├── ui/
│   └── StatusBarManager.ts (ステータスバー管理)
└── utils/
    ├── CommandWrapper.ts (共通エラーハンドリング)
    └── ProxyUtils.ts (共通ユーティリティ)
```

### 依存関係フロー

```
extension.ts
    ↓
CommandRegistry → Commands → ProxyApplier → ConfigManagers
    ↓                ↓
StatusBarManager  ProxyStateManager
```

## Components and Interfaces

### 1. core/types.ts

共通の型定義を集約：

```typescript
export enum ProxyMode {
    Off = 'off',
    Manual = 'manual',
    Auto = 'auto'
}

export interface ProxyState {
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    lastSystemProxyCheck?: number;
    gitConfigured?: boolean;
    vscodeConfigured?: boolean;
    npmConfigured?: boolean;
    systemProxyDetected?: boolean;
    lastError?: string;
}

export interface CommandContext {
    extensionContext: vscode.ExtensionContext;
    stateManager: ProxyStateManager;
    proxyApplier: ProxyApplier;
    statusBarManager: StatusBarManager;
}
```

### 2. core/ProxyStateManager.ts

状態の読み書きを管理：

```typescript
export class ProxyStateManager {
    private inMemoryState: ProxyState | null = null;
    
    constructor(private context: vscode.ExtensionContext) {}
    
    async getState(): Promise<ProxyState>
    async saveState(state: ProxyState): Promise<void>
    getActiveProxyUrl(state: ProxyState): string
    getNextMode(currentMode: ProxyMode): ProxyMode
    
    // 古い設定からの移行ロジック
    private async migrateOldSettings(): Promise<ProxyState>
}
```

### 3. core/ProxyApplier.ts

プロキシ設定の適用を管理：

```typescript
export class ProxyApplier {
    constructor(
        private gitManager: GitConfigManager,
        private vscodeManager: VscodeConfigManager,
        private npmManager: NpmConfigManager,
        private validator: ProxyUrlValidator,
        private sanitizer: InputSanitizer,
        private userNotifier: UserNotifier
    ) {}
    
    async applyProxy(proxyUrl: string, enabled: boolean): Promise<boolean>
    async disableProxy(): Promise<boolean>
    
    private async updateManager(
        manager: ConfigManager,
        name: string,
        enabled: boolean,
        proxyUrl: string,
        errorAggregator: ErrorAggregator
    ): Promise<boolean>
}
```

### 4. commands/CommandRegistry.ts

コマンドの登録を一元管理：

```typescript
export class CommandRegistry {
    constructor(private commandContext: CommandContext) {}
    
    registerAll(): vscode.Disposable[] {
        return [
            this.registerToggleProxy(),
            this.registerConfigureUrl(),
            this.registerTestProxy(),
            this.registerImportProxy(),
            this.registerConfigChangeListener(),
            this.registerWindowFocusListener()
        ];
    }
    
    private registerToggleProxy(): vscode.Disposable
    private registerConfigureUrl(): vscode.Disposable
    private registerTestProxy(): vscode.Disposable
    private registerImportProxy(): vscode.Disposable
    private registerConfigChangeListener(): vscode.Disposable
    private registerWindowFocusListener(): vscode.Disposable
}
```

### 5. commands/ToggleProxyCommand.ts

トグルコマンドの実装：

```typescript
export async function executeToggleProxy(ctx: CommandContext): Promise<void> {
    const currentState = await ctx.stateManager.getState();
    const nextMode = ctx.stateManager.getNextMode(currentState.mode);
    const i18n = I18nManager.getInstance();
    
    // モード切り替えロジック
    // ...
}
```

### 6. commands/ImportProxyCommand.ts

インポートコマンドの実装（重複削減）：

```typescript
export async function executeImportProxy(ctx: CommandContext): Promise<void> {
    const detectedProxy = await detectSystemProxySettings();
    if (!detectedProxy) {
        // エラー処理
        return;
    }
    
    const action = await promptUserAction(detectedProxy);
    await handleUserAction(action, detectedProxy, ctx);
}

// 重複していた3つのケースを統一
async function handleUserAction(
    action: string,
    proxyUrl: string,
    ctx: CommandContext
): Promise<void> {
    if (action === 'test') {
        const testResult = await testProxyConnection(proxyUrl);
        if (testResult.success) {
            const nextAction = await promptAfterTest();
            await applyProxyMode(nextAction, proxyUrl, ctx);
        }
    } else {
        await applyProxyMode(action, proxyUrl, ctx);
    }
}

// 共通の適用ロジック
async function applyProxyMode(
    mode: 'auto' | 'manual',
    proxyUrl: string,
    ctx: CommandContext
): Promise<void> {
    if (!validateProxyUrl(proxyUrl)) {
        // エラー処理
        return;
    }
    
    const state = await ctx.stateManager.getState();
    if (mode === 'auto') {
        state.autoProxyUrl = proxyUrl;
        state.mode = ProxyMode.Auto;
        await startSystemProxyMonitoring(ctx.extensionContext);
    } else {
        state.manualProxyUrl = proxyUrl;
        state.mode = ProxyMode.Manual;
    }
    
    await ctx.stateManager.saveState(state);
    await ctx.proxyApplier.applyProxy(proxyUrl, true);
    ctx.statusBarManager.update(state);
    // 成功通知
}
```

### 7. ui/StatusBarManager.ts

ステータスバーの管理：

```typescript
export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    
    constructor(
        context: vscode.ExtensionContext,
        private sanitizer: InputSanitizer,
        private proxyMonitor: ProxyMonitor,
        private proxyChangeLogger: ProxyChangeLogger
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'otak-proxy.toggleProxy';
        context.subscriptions.push(this.statusBarItem);
    }
    
    update(state: ProxyState): void {
        this.updateText(state);
        this.updateTooltip(state);
        this.statusBarItem.show();
    }
    
    private updateText(state: ProxyState): void
    private updateTooltip(state: ProxyState): void
    private validateCommandLinks(): void
}
```

### 8. utils/CommandWrapper.ts

共通のエラーハンドリング：

```typescript
export function wrapCommand(
    commandFn: (ctx: CommandContext) => Promise<void>
): (ctx: CommandContext) => Promise<void> {
    return async (ctx: CommandContext) => {
        try {
            await commandFn(ctx);
        } catch (error) {
            Logger.error('Command execution failed:', error);
            ctx.userNotifier.showError(
                'error.commandFailed',
                ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
            );
        }
    };
}
```

### 9. utils/ProxyUtils.ts

共通ユーティリティ：

```typescript
export function validateProxyUrl(url: string, validator: ProxyUrlValidator): boolean
export function sanitizeProxyUrl(url: string, sanitizer: InputSanitizer): string
export async function testProxyConnection(proxyUrl: string): Promise<TestResult>
export async function detectSystemProxySettings(detector: SystemProxyDetector): Promise<string | null>
```

## Data Models

既存のデータモデルは維持しますが、`core/types.ts`に集約します：

- `ProxyMode` enum
- `ProxyState` interface
- `CommandContext` interface (新規)

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Property 1: Command error handling consistency
*For any* command execution that throws an error, the system should log the error and display a user notification with troubleshooting suggestions
**Validates: Requirements 2.3**

Property 2: Command independence
*For any* two different commands executed sequentially, the execution of the first command should not affect the state or behavior of the second command (除く意図的な状態変更)
**Validates: Requirements 2.4**

Property 3: State persistence fallback
*For any* state update where globalState.update fails, the system should automatically use in-memory fallback and notify the user
**Validates: Requirements 3.2**

Property 4: Legacy state migration
*For any* old format state data, reading the state should transparently migrate it to the new format without data loss
**Validates: Requirements 3.3**

Property 5: Proxy enablement sequence
*For any* valid proxy URL, enabling the proxy should execute validation, then application, then error aggregation in that order
**Validates: Requirements 4.2**

Property 6: Proxy disablement completeness
*For any* proxy state, disabling the proxy should call unsetProxy on all ConfigManagers (Git, VSCode, npm)
**Validates: Requirements 4.3**

Property 7: Error aggregation on failure
*For any* ConfigManager that fails during proxy application, the error should be added to ErrorAggregator
**Validates: Requirements 4.4**

Property 8: Status bar state reflection
*For any* ProxyState, updating the status bar should generate text and tooltip that accurately reflect the current mode and URLs
**Validates: Requirements 5.2**

Property 9: Command link validation
*For any* tooltip generation, all command links should reference registered commands, and invalid links should generate warnings
**Validates: Requirements 5.3**

Property 10: Status bar internationalization
*For any* supported locale, the status bar text should be properly translated using I18nManager
**Validates: Requirements 5.4**

## Error Handling

リファクタリング後も既存のエラーハンドリング戦略を維持：

1. **ErrorAggregator**: 複数の設定エラーを集約
2. **UserNotifier**: ユーザーへの一貫した通知
3. **Logger**: 詳細なログ記録
4. **CommandWrapper**: コマンド実行時の共通エラーハンドリング

新しいエラーハンドリングパターン：

```typescript
// すべてのコマンドに適用
const wrappedCommand = wrapCommand(async (ctx) => {
    // コマンドロジック
});
```

## Testing Strategy

### Unit Testing

各新しいモジュールに対してユニットテストを作成：

- `ProxyStateManager.test.ts`: 状態の読み書き、移行ロジック
- `ProxyApplier.test.ts`: 設定適用、エラー集約
- `StatusBarManager.test.ts`: UI更新、ツールチップ生成
- `CommandRegistry.test.ts`: コマンド登録
- 各コマンドファイルに対応するテスト

### Property-Based Testing

以下のプロパティをfast-checkで検証：

1. **Command error handling** (Property 1)
   - 任意のエラーを注入してエラーハンドリングを検証
   - 実行回数: 50回

2. **State persistence fallback** (Property 3)
   - globalState.updateの失敗をシミュレート
   - 実行回数: 30回

3. **Legacy state migration** (Property 4)
   - 様々な古い形式の状態データを生成
   - 実行回数: 50回

4. **Proxy enablement sequence** (Property 5)
   - 有効なプロキシURLを生成して順序を検証
   - 実行回数: 30回

5. **Error aggregation** (Property 7)
   - ConfigManagerの失敗をシミュレート
   - 実行回数: 50回

6. **Status bar state reflection** (Property 8)
   - 様々なProxyStateを生成
   - 実行回数: 50回

### Integration Testing

既存の統合テストを維持しつつ、以下を追加：

- モジュール間の連携テスト
- エンドツーエンドのコマンド実行テスト

### Regression Testing

- すべての既存テストが合格することを確認
- テスト実行時間の改善を測定

### Test Performance Optimization

1. **環境変数による実行回数制御**:
   ```typescript
   const numRuns = process.env.CI ? 100 : 10;
   ```

2. **モックの活用**:
   - 外部コマンド（git, npm）はデフォルトでモック
   - 統合テストのみ実際のコマンドを使用

3. **並列実行**:
   - `.vscode-test.mjs`で並列実行を有効化
   - 独立したテストスイートを分離

4. **Fast-fail戦略**:
   - 最初の失敗で即座に停止するオプション

## Migration Strategy

段階的なリファクタリングアプローチ：

### Phase 1: 型定義の抽出
1. `core/types.ts`を作成
2. 既存のenum/interfaceを移動
3. テストを実行して確認

### Phase 2: ユーティリティの抽出
1. `utils/ProxyUtils.ts`を作成
2. 共通関数を移動
3. テストを実行して確認

### Phase 3: 状態管理の分離
1. `core/ProxyStateManager.ts`を作成
2. 状態関連の関数を移動
3. テストを実行して確認

### Phase 4: 設定適用の分離
1. `core/ProxyApplier.ts`を作成
2. applyProxySettings関連を移動
3. テストを実行して確認

### Phase 5: ステータスバーの分離
1. `ui/StatusBarManager.ts`を作成
2. updateStatusBar関連を移動
3. テストを実行して確認

### Phase 6: コマンドの分離
1. `commands/`フォルダを作成
2. 各コマンドを個別ファイルに移動
3. `CommandRegistry.ts`を作成
4. テストを実行して確認

### Phase 7: エントリーポイントの簡素化
1. `extension.ts`を簡素化
2. すべてのテストを実行
3. パフォーマンスを測定

各フェーズ後に：
- すべてのテストが合格することを確認
- コミットして変更を保存
- 必要に応じてロールバック可能にする

## Performance Considerations

### ファイルサイズ削減の効果

- **現在**: extension.ts 1335行
- **目標**: 
  - extension.ts: ~100行
  - 各モジュール: <300行
  - 合計: ~1500行（コメント・型定義の追加を含む）

### テスト実行時間の改善目標

- **現在**: 推定2-3分（外部コマンド依存が多い）
- **目標**: 
  - 開発モード: <30秒（モック使用、低実行回数）
  - CIモード: <2分（実際のコマンド、高実行回数）

### ビルド時間への影響

- モジュール分割により並列コンパイルが可能
- 増分ビルドの効率が向上
- 全体のビルド時間は同等またはわずかに改善

