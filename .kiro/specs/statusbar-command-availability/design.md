# Design Document

## Overview

この設計は、ステータスバーのツールチップに表示されるコマンドリンクが、拡張機能のインストール直後や任意の状態で常に実行可能であることを保証する。現在の実装では、コマンドの登録とステータスバーの初期化の順序が適切に管理されていないため、一部のコマンドが実行できない場合がある。

この問題を解決するために、以下のアプローチを採用する：

1. **コマンド登録の早期化**: すべてのコマンドをステータスバー表示前に登録
2. **状態チェックの改善**: コマンド実行時に状態を確認し、適切なフィードバックを提供
3. **初期化順序の明確化**: activate関数内の処理順序を最適化

## Architecture

### Current Architecture Issues

現在の`activate`関数の処理順序：

```
1. Logger初期化
2. StatusBar初期化
3. ProxyMonitor初期化
4. ProxyState取得
5. StatusBar更新（コマンドリンク表示）
6. 初期セットアップチェック
7. コマンド登録（toggleProxy, configureUrl, testProxy, importProxy）
```

**問題点**: ステップ5でコマンドリンクが表示されるが、ステップ7までコマンドが登録されていない。

### Proposed Architecture

改善後の処理順序：

```
1. Logger初期化
2. StatusBar初期化（表示はまだしない）
3. ProxyMonitor初期化
4. ProxyState取得
5. **すべてのコマンド登録**
6. StatusBar更新と表示（コマンドリンク表示）
7. 初期セットアップチェック
8. プロキシ設定の適用
9. モニタリング開始
```

## Components and Interfaces

### Modified Components

#### 1. activate Function

**変更内容**:
- コマンド登録をステータスバー更新の前に移動
- 初期化の各ステップを明確に分離

**新しい構造**:
```typescript
export async function activate(context: vscode.ExtensionContext) {
    // Phase 1: Core initialization
    Logger.log('Extension "otak-proxy" is now active.');
    statusBarItem = initializeStatusBar(context);
    initializeProxyMonitor(context);
    
    // Phase 2: State initialization
    let state = await getProxyState(context);
    
    // Phase 3: Command registration (BEFORE status bar display)
    registerCommands(context);
    
    // Phase 4: UI initialization
    updateStatusBar(state);
    
    // Phase 5: Initial setup and monitoring
    await performInitialSetup(context);
    await startSystemProxyMonitoring(context);
}
```

#### 2. New Helper Function: registerCommands

**目的**: すべてのコマンド登録を一箇所に集約し、初期化順序を明確にする

**シグネチャ**:
```typescript
function registerCommands(context: vscode.ExtensionContext): void
```

**実装内容**:
- toggleProxy コマンド
- configureUrl コマンド
- testProxy コマンド
- importProxy コマンド
- 設定変更リスナー
- ウィンドウフォーカスリスナー

#### 3. New Helper Function: performInitialSetup

**目的**: 初期セットアップロジックを分離し、コマンド登録後に実行

**シグネチャ**:
```typescript
async function performInitialSetup(context: vscode.ExtensionContext): Promise<void>
```

**実装内容**:
- hasInitialSetup フラグのチェック
- askForInitialSetup の呼び出し
- プロキシ設定の適用

### Command Handlers Enhancement

各コマンドハンドラーに状態チェックと適切なエラーハンドリングを追加：

#### testProxy Command

**現在の問題**: プロキシが未設定の場合、エラーメッセージが表示されるが、次のアクションが不明確

**改善**:
```typescript
// エラーメッセージに具体的なアクションボタンを追加
if (!activeUrl) {
    const action = await vscode.window.showErrorMessage(
        `No proxy configured. Current mode: ${state.mode.toUpperCase()}`,
        'Configure Manual',
        'Import System',
        'Cancel'
    );
    
    if (action === 'Configure Manual') {
        await vscode.commands.executeCommand('otak-proxy.configureUrl');
    } else if (action === 'Import System') {
        await vscode.commands.executeCommand('otak-proxy.importProxy');
    }
    return;
}
```

#### configureUrl Command

**現在の実装**: 既に適切に動作しているが、初期化順序の問題で実行できない場合がある

**改善**: コマンド登録を早期化することで解決（コード変更不要）

#### importProxy Command

**現在の実装**: 既に適切に動作しているが、初期化順序の問題で実行できない場合がある

**改善**: コマンド登録を早期化することで解決（コード変更不要）

## Data Models

既存のデータモデルは変更不要。

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Acceptance Criteria Testing Prework

1.1 WHEN the extension is activated THEN the system SHALL register all command handlers before displaying the status bar
Thoughts: これは初期化の順序に関する要件。拡張機能がアクティブになった時点で、ステータスバーが表示される前にすべてのコマンドが登録されているべき。これは特定の実行順序をテストするもので、プロパティテストには適さない。
Testable: yes - example

1.2 WHEN a user hovers over the status bar item THEN the system SHALL display all command links as clickable
Thoughts: これはUI表示の要件。ツールチップが表示された時点で、すべてのコマンドリンクがクリック可能であることを確認する。これはUI動作のテストで、プロパティテストには適さない。
Testable: no

1.3 WHEN a user clicks any command link in the tooltip THEN the system SHALL execute the corresponding command without errors
Thoughts: これはすべてのコマンドリンクに対して成り立つべき性質。任意のコマンドリンクをクリックした場合、対応するコマンドがエラーなく実行されるべき。
Testable: yes - property

1.4 WHEN the extension state is not fully initialized THEN the system SHALL handle command execution gracefully with appropriate user feedback
Thoughts: これは初期化が完了していない状態での動作。エッジケースとして扱い、ジェネレーターで初期化前の状態を生成してテストする。
Testable: edge-case

2.1 WHEN a user clicks "Configure Manual" with no proxy configured THEN the system SHALL display the proxy URL input dialog
Thoughts: これは特定の状態（プロキシ未設定）での動作。エグザンプルテストとして実装する。
Testable: yes - example

2.2 WHEN a user enters a valid proxy URL THEN the system SHALL save it and update the status bar
Thoughts: これは任意の有効なプロキシURLに対して成り立つべき性質。ランダムな有効URLを生成してテストできる。
Testable: yes - property

2.3 WHEN a user cancels the input dialog THEN the system SHALL maintain the current state without errors
Thoughts: これはキャンセル操作の動作。特定のシナリオなのでエグザンプルテストとして実装する。
Testable: yes - example

2.4 WHEN a user enters an invalid proxy URL THEN the system SHALL display validation errors and allow retry
Thoughts: これは任意の無効なプロキシURLに対して成り立つべき性質。ランダムな無効URLを生成してテストできる。
Testable: yes - property

3.1 WHEN a user clicks "Test Proxy" with no proxy configured THEN the system SHALL display an informative error message
Thoughts: これは特定の状態（プロキシ未設定）での動作。エグザンプルテストとして実装する。
Testable: yes - example

3.2 WHEN the error message is displayed THEN the system SHALL include suggestions for configuring a proxy
Thoughts: これはエラーメッセージの内容に関する要件。エラーメッセージに特定の文字列が含まれることを確認する。
Testable: yes - example

3.3 WHEN a user clicks "Test Proxy" with a configured proxy THEN the system SHALL execute the connection test
Thoughts: これは任意の設定済みプロキシに対して成り立つべき性質。ランダムなプロキシ設定を生成してテストできる。
Testable: yes - property

3.4 WHEN the test completes THEN the system SHALL display the result with appropriate success or failure messages
Thoughts: これはテスト完了後の動作。成功と失敗の両方のケースをテストする必要がある。
Testable: yes - property

4.1 WHEN a user clicks "Import System" THEN the system SHALL attempt to detect system proxy settings
Thoughts: これは特定のコマンド実行の動作。エグザンプルテストとして実装する。
Testable: yes - example

4.2 WHEN system proxy is detected THEN the system SHALL display options to use or save the detected proxy
Thoughts: これは検出成功時の動作。特定のシナリオなのでエグザンプルテストとして実装する。
Testable: yes - example

4.3 WHEN no system proxy is detected THEN the system SHALL display an informative message with suggestions
Thoughts: これは検出失敗時の動作。特定のシナリオなのでエグザンプルテストとして実装する。
Testable: yes - example

4.4 WHEN detection fails THEN the system SHALL handle the error gracefully and inform the user
Thoughts: これはエラーハンドリングの動作。任意のエラーに対して成り立つべき性質。
Testable: yes - property

5.1 WHEN the extension activates THEN the system SHALL register all commands before showing the status bar
Thoughts: これは1.1と同じ要件。初期化順序のテスト。
Testable: yes - example

5.2 WHEN a command is executed THEN the system SHALL verify that required dependencies are initialized
Thoughts: これは任意のコマンドに対して成り立つべき性質。ランダムなコマンドを選択してテストできる。
Testable: yes - property

5.3 WHEN dependencies are not ready THEN the system SHALL queue the command or display an appropriate message
Thoughts: これは依存関係が未初期化の状態での動作。エッジケースとして扱う。
Testable: edge-case

5.4 WHEN the status bar is updated THEN the system SHALL ensure all command links reference registered commands
Thoughts: これはステータスバー更新時の不変条件。任意のステータスバー更新に対して成り立つべき性質。
Testable: yes - property

### Property Reflection

プロパティの冗長性を確認：

- **Property 1.3** (任意のコマンドリンクがエラーなく実行される) と **Property 5.2** (コマンド実行時に依存関係を確認) は関連しているが、異なる側面をテストしている。1.3はコマンドの実行可能性、5.2は依存関係チェックの存在。両方保持。

- **Property 2.2** (有効なURLの保存) と **Property 2.4** (無効なURLのバリデーション) は相補的。両方保持。

- **Property 3.3** (テスト実行) と **Property 3.4** (結果表示) は連続した動作だが、3.4は3.3を包含する。**Property 3.3を削除し、3.4に統合**。

- **Property 4.4** (検出失敗時のエラーハンドリング) は一般的なエラーハンドリングをカバー。保持。

- **Property 5.4** (コマンドリンクが登録済みコマンドを参照) は **Property 1.3** (コマンドリンクが実行可能) と関連しているが、5.4はより具体的な不変条件。両方保持。

### Correctness Properties

Property 1: Command registration precedes status bar display
*For any* extension activation, all command handlers must be registered before the status bar is displayed with command links
**Validates: Requirements 1.1, 5.1**

Property 2: Command links are executable
*For any* command link displayed in the status bar tooltip, clicking it should execute the corresponding command without throwing an error
**Validates: Requirements 1.3**

Property 3: Valid proxy URL persistence
*For any* valid proxy URL entered by the user, the system should save it to the state and the saved value should match the input
**Validates: Requirements 2.2**

Property 4: Invalid proxy URL rejection
*For any* invalid proxy URL entered by the user, the system should display validation errors and not save the invalid value
**Validates: Requirements 2.4**

Property 5: Test result display
*For any* proxy configuration, when a connection test completes, the system should display either a success message (if test passed) or an error message with suggestions (if test failed)
**Validates: Requirements 3.4**

Property 6: Error handling for detection failures
*For any* error during system proxy detection, the system should handle it gracefully without crashing and inform the user with an appropriate message
**Validates: Requirements 4.4**

Property 7: Command dependency verification
*For any* command execution, the system should verify that required dependencies (ProxyMonitor, StatusBar, etc.) are initialized before proceeding
**Validates: Requirements 5.2**

Property 8: Command link validity
*For any* status bar update, all command links in the tooltip should reference commands that are registered in the extension context
**Validates: Requirements 5.4**

## Error Handling

### Command Execution Errors

すべてのコマンドハンドラーに try-catch ブロックを追加し、予期しないエラーをキャッチ：

```typescript
try {
    // Command logic
} catch (error) {
    Logger.error('Command execution failed:', error);
    userNotifier.showError(
        'Command execution failed',
        ['Check the output log for details', 'Try reloading the window']
    );
}
```

### Initialization Errors

初期化中のエラーを適切にハンドリング：

```typescript
try {
    await performInitialSetup(context);
} catch (error) {
    Logger.error('Initial setup failed:', error);
    // Continue with default state
}
```

### State Access Errors

状態アクセス時のエラーハンドリング（既存の実装を維持）：

```typescript
try {
    const state = await getProxyState(context);
    // Use state
} catch (error) {
    Logger.error('Failed to get proxy state:', error);
    // Use default state or in-memory fallback
}
```

## Testing Strategy

### Unit Testing

以下の単体テストを実装：

1. **Command Registration Test**
   - すべてのコマンドが登録されることを確認
   - コマンドIDが正しいことを確認

2. **Initialization Order Test**
   - activate関数の実行順序を確認
   - コマンド登録がステータスバー表示前に行われることを確認

3. **Command Handler Tests**
   - 各コマンドハンドラーが適切に動作することを確認
   - エラーケースのハンドリングを確認

4. **Status Bar Update Test**
   - ステータスバーのツールチップに正しいコマンドリンクが含まれることを確認
   - コマンドリンクが登録済みコマンドを参照することを確認

### Property-Based Testing

fast-checkライブラリを使用して以下のプロパティテストを実装：

1. **Property 2: Command links are executable**
   - ジェネレーター: 登録済みコマンドIDのリスト
   - テスト: 各コマンドIDに対応するコマンドが実行可能

2. **Property 3: Valid proxy URL persistence**
   - ジェネレーター: 有効なプロキシURL（http://host:port形式）
   - テスト: URLを保存して取得した値が一致

3. **Property 4: Invalid proxy URL rejection**
   - ジェネレーター: 無効なプロキシURL（プロトコル欠落、無効なホスト名等）
   - テスト: バリデーションエラーが発生し、保存されない

4. **Property 5: Test result display**
   - ジェネレーター: プロキシ設定（有効/無効、設定済み/未設定）
   - テスト: テスト完了後に適切なメッセージが表示される

5. **Property 6: Error handling for detection failures**
   - ジェネレーター: 様々なエラー条件（ネットワークエラー、タイムアウト等）
   - テスト: エラーが適切にハンドリングされ、クラッシュしない

6. **Property 7: Command dependency verification**
   - ジェネレーター: コマンドIDと初期化状態の組み合わせ
   - テスト: 依存関係が未初期化の場合、適切なエラーメッセージが表示される

7. **Property 8: Command link validity**
   - ジェネレーター: 様々なProxyState
   - テスト: ステータスバー更新後、すべてのコマンドリンクが登録済みコマンドを参照

### Integration Testing

以下の統合テストを実装：

1. **Full Activation Flow Test**
   - 拡張機能のアクティベーションから初期表示までの完全なフローをテスト
   - すべてのコマンドが実行可能であることを確認

2. **Command Interaction Test**
   - 複数のコマンドを連続して実行
   - 状態の一貫性を確認

### Test Configuration

- プロパティテストは最低100回の反復を実行
- 各プロパティテストには設計ドキュメントのプロパティ番号を明記
- テストファイル: `src/test/statusbar-commands.test.ts`
- プロパティテストファイル: `src/test/statusbar-commands.property.test.ts`

## Implementation Notes

### Migration Strategy

既存のコードへの影響を最小限に抑えるため、以下の段階的なアプローチを採用：

1. **Phase 1**: registerCommands関数とperformInitialSetup関数を作成
2. **Phase 2**: activate関数をリファクタリングし、新しい関数を使用
3. **Phase 3**: testProxyコマンドにアクションボタンを追加
4. **Phase 4**: テストを実装して動作を検証

### Backward Compatibility

- 既存のコマンドIDは変更しない
- 既存の設定項目は変更しない
- 既存のProxyStateフォーマットは変更しない

### Performance Considerations

- コマンド登録は軽量な操作なので、パフォーマンスへの影響は無視できる
- 初期化順序の変更により、ステータスバー表示が若干遅れる可能性があるが、ユーザーには気づかれないレベル
