# Design Document

## Overview

このドキュメントは、otak-proxy拡張機能の通知システムとユーザーエクスペリエンスを改善するための設計を定義します。現在の実装では、エラーメッセージが長すぎて読みにくく、通知が自動で閉じないため、ユーザーが手動で閉じる必要があります。また、詳細情報へのアクセスが困難で、通知の重複が発生する問題があります。

この設計では、以下の主要な改善を実装します：

1. **通知の簡潔化**: エラーメッセージを要約し、詳細情報は出力チャネルに配置
2. **自動閉じる機能**: 通知タイプに応じて自動的に閉じる
3. **出力チャネルの統合**: 詳細情報を一元管理し、「詳細を表示」ボタンで簡単にアクセス
4. **通知の重複抑制**: 同じメッセージが短時間に複数回表示されないように制御
5. **進行状況の改善**: テスト中の進行状況を視覚的に表示
6. **アクションボタンの強化**: 通知から直接アクションを実行できるボタンを追加

## Architecture

### 既存のコンポーネント

- **UserNotifier**: 通知を管理するクラス（改善対象）
- **StatusBarManager**: ステータスバーを管理するクラス（軽微な改善）
- **Logger**: ログを管理するクラス（出力チャネルとの統合）

### 新規コンポーネント

- **OutputChannelManager**: 出力チャネルを管理し、詳細情報を記録する新しいクラス
- **NotificationThrottler**: 通知の重複を抑制するクラス
- **NotificationFormatter**: 通知メッセージをフォーマットするユーティリティクラス

### コンポーネント間の関係

```
UserNotifier
  ├─> OutputChannelManager (詳細情報の記録)
  ├─> NotificationThrottler (重複抑制)
  └─> NotificationFormatter (メッセージのフォーマット)

Commands (TestProxyCommand, etc.)
  └─> UserNotifier (通知の表示)

Logger
  └─> OutputChannelManager (ログの出力)
```

## Components and Interfaces

### OutputChannelManager

出力チャネルを管理し、詳細情報を記録するクラス。

```typescript
export class OutputChannelManager {
    private static instance: OutputChannelManager;
    private outputChannel: vscode.OutputChannel;
    
    private constructor();
    static getInstance(): OutputChannelManager;
    
    // 詳細情報を記録
    logError(message: string, details: ErrorDetails): void;
    logInfo(message: string, details?: any): void;
    logWarning(message: string, details?: any): void;
    
    // 出力チャネルを表示
    show(): void;
    
    // 出力チャネルをクリア
    clear(): void;
}

interface ErrorDetails {
    timestamp: Date;
    errorMessage: string;
    stackTrace?: string;
    attemptedUrls?: string[];
    suggestions?: string[];
    context?: Record<string, any>;
}
```

### NotificationThrottler

通知の重複を抑制するクラス。

```typescript
export class NotificationThrottler {
    private lastNotifications: Map<string, number>;
    private readonly defaultThrottleMs = 5000;
    
    // 通知を表示すべきかチェック
    shouldShow(messageKey: string, throttleMs?: number): boolean;
    
    // 通知を記録
    recordNotification(messageKey: string): void;
    
    // スロットルをクリア
    clear(): void;
}
```

### NotificationFormatter

通知メッセージをフォーマットするユーティリティクラス。

```typescript
export class NotificationFormatter {
    private static readonly MAX_MESSAGE_LENGTH = 200;
    
    // メッセージを要約
    static summarize(message: string, maxLength?: number): string;
    
    // 提案を要約（最も重要なもののみ）
    static summarizeSuggestions(suggestions: string[], maxCount?: number): string[];
    
    // URLリストを要約
    static summarizeUrls(urls: string[], maxCount?: number): string;
    
    // エラーメッセージをフォーマット
    static formatError(message: string, primarySuggestion?: string): string;
}
```

### UserNotifier (改善版)

既存のUserNotifierクラスを拡張し、新機能を追加。

```typescript
export class UserNotifier {
    private i18n: I18nManager;
    private outputManager: OutputChannelManager;
    private throttler: NotificationThrottler;
    
    constructor();
    
    // 既存のメソッド（改善）
    showError(message: string, suggestions?: string[], params?: Record<string, string>): void;
    showSuccess(message: string, params?: Record<string, string>): void;
    showWarning(message: string, params?: Record<string, string>): void;
    
    // 新しいメソッド
    showErrorWithDetails(
        message: string,
        details: ErrorDetails,
        suggestions?: string[],
        params?: Record<string, string>
    ): void;
    
    showProgressNotification(
        title: string,
        task: (progress: vscode.Progress<any>) => Promise<any>,
        cancellable?: boolean
    ): Promise<any>;
    
    // 内部メソッド
    private showNotificationWithTimeout(
        type: 'info' | 'warning' | 'error',
        message: string,
        timeoutMs?: number,
        actions?: string[]
    ): Promise<string | undefined>;
}
```

## Data Models

### NotificationConfig

通知の設定を定義するインターフェース。

```typescript
interface NotificationConfig {
    type: 'info' | 'warning' | 'error' | 'success';
    message: string;
    autoCloseMs?: number;  // 自動的に閉じるまでの時間（ミリ秒）
    actions?: NotificationAction[];
    showDetailsButton?: boolean;
    throttleKey?: string;  // 重複抑制のキー
    throttleMs?: number;   // 重複抑制の時間
}

interface NotificationAction {
    label: string;
    command: string;
    args?: any[];
}
```

### ErrorDetails

エラーの詳細情報を定義するインターフェース。

```typescript
interface ErrorDetails {
    timestamp: Date;
    errorMessage: string;
    stackTrace?: string;
    attemptedUrls?: string[];
    suggestions?: string[];
    context?: Record<string, any>;
}
```

## 
Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: メッセージ長制限

*For any* エラーメッセージ、通知に表示されるメッセージの長さは200文字以内であること
**Validates: Requirements 1.4**

この要件は、ユーザーが通知を素早く読めるようにするために重要です。長いメッセージは要約され、詳細情報は出力チャネルに配置されます。

### Property 2: 提案の要約

*For any* 提案のリスト、通知に表示される提案の数は最大3つまでであること
**Validates: Requirements 1.2**

複数の提案がある場合、最も重要な提案のみを通知に表示し、残りは出力チャネルに配置します。これにより、通知が簡潔になります。

### Property 3: URLリストの要約

*For any* URLのリスト、通知に表示されるURLの数は最大2つまでであること
**Validates: Requirements 1.3**

長いURLリストは要約され、完全なリストは出力チャネルに記録されます。

### Property 4: 出力チャネルの完全性

*For any* エラー詳細情報、出力チャネルに記録される情報にはタイムスタンプ、エラーメッセージ、試行されたURL、提案が含まれること
**Validates: Requirements 3.3, 3.4**

詳細情報は出力チャネルに完全に記録され、ユーザーが必要に応じて確認できるようにします。

### Property 5: 通知の重複抑制

*For any* 通知メッセージ、同じメッセージが指定された時間内に複数回表示されないこと
**Validates: Requirements 7.1, 7.2, 7.3**

同じメッセージが短時間に複数回表示されることを防ぎ、ユーザーエクスペリエンスを向上させます。抑制された通知は出力チャネルに記録されます。

### Property 6: 連続失敗の通知制御

*For any* 連続失敗のシーケンス、通知は最初の失敗と5回目の失敗のみ表示されること
**Validates: Requirements 7.4**

連続して失敗が発生した場合、すべての失敗を通知するのではなく、重要なポイントのみを通知します。

### Property 7: 進行状況メッセージの正確性

*For any* 複数のURLをテストする場合、進行状況メッセージには現在のURL番号と総数が正しく表示されること
**Validates: Requirements 4.2**

進行状況を視覚的に表示することで、ユーザーはテストの進行状況を把握できます。

## Error Handling

### エラーの分類

1. **ユーザー入力エラー**: 無効なプロキシURL、設定エラーなど
2. **ネットワークエラー**: プロキシ接続失敗、タイムアウトなど
3. **システムエラー**: 出力チャネルの作成失敗、内部エラーなど

### エラー処理戦略

1. **ユーザー入力エラー**:
   - 簡潔なエラーメッセージを通知に表示
   - 修正方法を提案するアクションボタンを提供
   - 詳細情報を出力チャネルに記録

2. **ネットワークエラー**:
   - エラーの要約を通知に表示
   - 「再試行」と「設定を変更」のアクションボタンを提供
   - 試行されたすべてのURLとエラーを出力チャネルに記録

3. **システムエラー**:
   - 一般的なエラーメッセージを通知に表示
   - 「ログを確認」アクションボタンを提供
   - スタックトレースを含む詳細情報を出力チャネルに記録

### フォールバック処理

- 出力チャネルの作成に失敗した場合、コンソールにログを出力
- 通知の表示に失敗した場合、ステータスバーにエラーアイコンを表示
- 重複抑制機能が失敗した場合、通常の通知を表示

## Testing Strategy

### Unit Testing

以下のコンポーネントに対してユニットテストを実施します：

1. **NotificationFormatter**:
   - メッセージの要約機能
   - 提案の要約機能
   - URLリストの要約機能
   - エラーメッセージのフォーマット

2. **NotificationThrottler**:
   - 通知の重複抑制機能
   - タイムアウトの管理
   - クリア機能

3. **OutputChannelManager**:
   - 詳細情報の記録
   - 出力チャネルの表示
   - クリア機能

4. **UserNotifier (改善版)**:
   - エラー通知の表示
   - 成功通知の表示
   - 警告通知の表示
   - 詳細情報付きエラー通知
   - 進行状況通知

### Property-Based Testing

fast-checkライブラリを使用して、以下のプロパティをテストします：

1. **Property 1: メッセージ長制限**
   - ランダムな長さのメッセージを生成
   - 通知に表示されるメッセージが200文字以内であることを確認
   - 最小100回のイテレーション

2. **Property 2: 提案の要約**
   - ランダムな数の提案を生成（0-10個）
   - 通知に表示される提案が最大3つまでであることを確認
   - 最小100回のイテレーション

3. **Property 3: URLリストの要約**
   - ランダムな数のURLを生成（0-20個）
   - 通知に表示されるURLが最大2つまでであることを確認
   - 最小100回のイテレーション

4. **Property 4: 出力チャネルの完全性**
   - ランダムなエラー詳細情報を生成
   - 出力チャネルに記録される情報が完全であることを確認
   - 最小100回のイテレーション

5. **Property 5: 通知の重複抑制**
   - ランダムなメッセージとタイミングを生成
   - 同じメッセージが指定時間内に複数回表示されないことを確認
   - 最小100回のイテレーション

6. **Property 6: 連続失敗の通知制御**
   - ランダムな数の連続失敗を生成（1-10回）
   - 通知が最初と5回目のみ表示されることを確認
   - 最小100回のイテレーション

7. **Property 7: 進行状況メッセージの正確性**
   - ランダムな数のURLを生成（1-10個）
   - 進行状況メッセージに正しい番号が含まれることを確認
   - 最小100回のイテレーション

各プロパティベーステストには、設計ドキュメントのプロパティ番号を参照するコメントを含めます：
```typescript
// Feature: notification-ux-improvements, Property 1: メッセージ長制限
```

### Integration Testing

以下の統合テストを実施します：

1. **通知フロー全体**:
   - エラー発生 → 通知表示 → 詳細表示ボタンクリック → 出力チャネル表示

2. **重複抑制フロー**:
   - 同じエラーを短時間に複数回発生 → 通知が1回のみ表示 → 出力チャネルにすべて記録

3. **進行状況フロー**:
   - プロキシテスト開始 → 進行状況通知表示 → テスト完了 → 結果通知表示

### Test Coverage Goals

- ユニットテスト: 90%以上のコードカバレッジ
- プロパティベーステスト: すべての正確性プロパティをカバー
- 統合テスト: 主要なユーザーフローをカバー

## Implementation Notes

### VSCode API の制限

VSCodeの通知APIには以下の制限があります：

1. **自動閉じる機能**: VSCodeの通知APIは自動的に閉じる機能を直接サポートしていません。代わりに、通知を表示した後、一定時間後に新しい通知を表示することで、古い通知を押し出す方法を検討します。

2. **通知のカスタマイズ**: VSCodeの通知は限られたカスタマイズオプションしか提供していません。アイコンはVSCodeのテーマアイコンを使用します。

3. **進行状況通知**: `vscode.window.withProgress`を使用して進行状況を表示できますが、カスタマイズオプションは限られています。

### パフォーマンス考慮事項

1. **通知の重複抑制**: メモリ使用量を抑えるため、古い通知記録は定期的にクリアします（例：1時間以上前の記録）。

2. **出力チャネル**: 出力チャネルのサイズが大きくなりすぎないように、古いログは定期的にクリアします（例：1000行を超えた場合）。

3. **メッセージのフォーマット**: メッセージのフォーマット処理は軽量に保ち、パフォーマンスへの影響を最小限に抑えます。

### 国際化

すべての通知メッセージは国際化対応します：

- 新しいメッセージキーを`src/i18n/locales/en.json`と`src/i18n/locales/ja.json`に追加
- メッセージのフォーマットはロケールに依存しないようにします
- アクションボタンのラベルも国際化します

### 後方互換性

既存のコードとの互換性を維持するため：

- `UserNotifier`の既存のメソッドは変更せず、新しいメソッドを追加
- 既存のコマンドは段階的に新しい通知システムに移行
- 設定ファイルに新しいオプションを追加（デフォルト値で後方互換性を維持）
