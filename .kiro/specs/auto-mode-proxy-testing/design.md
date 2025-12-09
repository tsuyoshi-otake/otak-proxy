# Design Document

## Overview

このドキュメントは、otak-proxy拡張機能のAutoモードにおけるプロキシ接続テスト機能の設計を定義します。現在の実装では、ProxyMonitorがシステムプロキシの設定を検出するだけで、実際にそのプロキシが疎通可能かどうかをテストしていません。

この設計では、以下の主要な改善を実装します：

1. **接続テストの統合**: システムプロキシ検出時に自動的に接続テストを実行
2. **高速な並列テスト**: 複数のテストURLを並列実行し、最初に成功したものを採用
3. **定期的な疎通確認**: 1分ごとにプロキシの疎通状態をチェック
4. **スマートな状態管理**: テスト結果に基づいてプロキシのON/OFFを自動切り替え
5. **手動/自動テストの区別**: ユーザー操作と自動テストで異なるタイムアウトと通知を使用

## Architecture

### 既存のコンポーネント

- **ProxyMonitor**: システムプロキシの変更を監視（拡張対象）
- **ProxyUtils**: プロキシ関連のユーティリティ関数（testProxyConnection を改善）
- **ExtensionInitializer**: 拡張機能の初期化処理（接続テスト統合）
- **UserNotifier**: 通知管理（既存機能を使用）

### 新規コンポーネント

- **ProxyConnectionTester**: プロキシ接続テストを管理する新しいクラス
- **ProxyTestScheduler**: 定期的なテスト実行をスケジュールするクラス

### コンポーネント間の関係

```
ProxyMonitor
  ├─> ProxyConnectionTester (接続テスト実行)
  └─> ProxyTestScheduler (定期テスト管理)

ProxyConnectionTester
  ├─> ProxyUtils.testProxyConnection (実際のテスト実行)
  └─> UserNotifier (テスト結果の通知)

ProxyTestScheduler
  ├─> ProxyConnectionTester (定期テスト実行)
  └─> Configuration (テスト間隔の取得)

ExtensionInitializer
  └─> ProxyConnectionTester (起動時のテスト)
```

## Components and Interfaces

### ProxyConnectionTester

プロキシ接続テストを管理するクラス。

```typescript
export class ProxyConnectionTester {
    private userNotifier: UserNotifier;
    private lastTestResult: Map<string, TestResult>;
    private testInProgress: boolean;
    
    constructor(userNotifier: UserNotifier);
    
    // 自動テストを実行（3秒タイムアウト、並列実行）
    async testProxyAuto(proxyUrl: string): Promise<TestResult>;
    
    // 手動テストを実行（5秒タイムアウト、詳細結果）
    async testProxyManual(proxyUrl: string): Promise<TestResult>;
    
    // 最後のテスト結果を取得
    getLastTestResult(proxyUrl: string): TestResult | undefined;
    
    // テスト中かどうかを確認
    isTestInProgress(): boolean;
    
    // 内部メソッド
    private notifyTestResult(proxyUrl: string, result: TestResult, isAuto: boolean): void;
}

interface TestResult {
    success: boolean;
    proxyUrl: string;
    timestamp: number;
    testUrls: string[];
    errors?: TestUrlError[];
    duration?: number;
}

interface TestUrlError {
    url: string;
    message: string;
}
```

### ProxyTestScheduler

定期的なテスト実行をスケジュールするクラス。

```typescript
export class ProxyTestScheduler {
    private tester: ProxyConnectionTester;
    private interval?: NodeJS.Timeout;
    private testIntervalMs: number;
    private isActive: boolean;
    private currentProxyUrl?: string;
    private onTestComplete?: (result: TestResult) => void;
    
    constructor(tester: ProxyConnectionTester, testIntervalMs: number);
    
    // スケジューラーを開始
    start(proxyUrl: string, onTestComplete: (result: TestResult) => void): void;
    
    // スケジューラーを停止
    stop(): void;
    
    // テスト間隔を更新
    updateInterval(intervalMs: number): void;
    
    // プロキシURLを更新
    updateProxyUrl(proxyUrl: string): void;
    
    // 即座にテストを実行
    triggerImmediateTest(): Promise<void>;
}
```

### ProxyUtils の改善

既存の `testProxyConnection` を改善し、並列テストをサポート。

```typescript
// 既存の関数を拡張
export async function testProxyConnection(
    proxyUrl: string,
    options?: TestOptions
): Promise<TestResult>;

interface TestOptions {
    timeout?: number;          // タイムアウト（ミリ秒）
    parallel?: boolean;        // 並列実行するか
    testUrls?: string[];       // テストするURL（省略時はデフォルト）
}

// 並列テスト用の新しい関数
export async function testProxyConnectionParallel(
    proxyUrl: string,
    testUrls: string[],
    timeout: number
): Promise<TestResult>;
```

### ProxyMonitor の拡張

既存の ProxyMonitor に接続テスト機能を統合。

```typescript
export class ProxyMonitor extends EventEmitter {
    // 既存のフィールド
    private tester: ProxyConnectionTester;
    private scheduler: ProxyTestScheduler;
    
    // 新しいイベント
    // - 'proxyTestComplete': テスト完了時
    // - 'proxyStateChanged': プロキシ状態変更時（ON/OFF）
    
    // 既存のメソッドを拡張
    private async executeCheck(trigger: string): Promise<ProxyDetectionResult> {
        // システムプロキシを検出
        const detection = await this.detectProxy();
        
        // 検出されたプロキシをテスト
        if (detection.proxyUrl) {
            const testResult = await this.tester.testProxyAuto(detection.proxyUrl);
            
            // テスト結果に基づいてプロキシ状態を決定
            const effectiveProxyUrl = testResult.success ? detection.proxyUrl : null;
            
            return {
                proxyUrl: effectiveProxyUrl,
                source: detection.source,
                timestamp: Date.now(),
                success: true,
                testResult: testResult
            };
        }
        
        return detection;
    }
}
```

## Data Models

### TestResult

テスト結果を表すインターフェース。

```typescript
interface TestResult {
    success: boolean;           // テスト成功/失敗
    proxyUrl: string;          // テストしたプロキシURL
    timestamp: number;         // テスト実行時刻
    testUrls: string[];        // テストしたURL一覧
    errors?: TestUrlError[];   // エラー情報（失敗時）
    duration?: number;         // テスト実行時間（ミリ秒）
}
```

### ProxyState の拡張

既存の ProxyState に接続テスト関連の情報を追加。

```typescript
interface ProxyState {
    // 既存のフィールド
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    
    // 新しいフィールド
    lastTestResult?: TestResult;        // 最後のテスト結果
    proxyReachable?: boolean;           // プロキシが疎通可能か
    lastTestTimestamp?: number;         // 最後のテスト実行時刻
}
```

### Configuration

テスト間隔の設定。

```typescript
// package.json の configuration セクションに追加
{
    "otakProxy.testInterval": {
        "type": "number",
        "default": 60,
        "minimum": 30,
        "maximum": 600,
        "description": "Proxy connection test interval in seconds (Auto mode only)"
    }
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: システムプロキシ検出時のテスト実行

*For any* システムプロキシURL、検出された時に接続テストが実行されること
**Validates: Requirements 1.1**

システムプロキシが検出されたら、必ず接続テストを実行して疎通可否を確認します。これにより、設定されているだけで実際には使えないプロキシを使用することを防ぎます。

### Property 2: テスト成功時のプロキシ有効化

*For any* プロキシURLとテスト結果、テストが成功した場合はプロキシが有効化されること
**Validates: Requirements 1.2, 4.2, 5.2**

接続テストが成功したプロキシのみを有効化することで、実際に疎通可能なプロキシだけを使用します。

### Property 3: テスト失敗時のプロキシ無効化

*For any* プロキシURLとテスト結果、テストが失敗した場合はプロキシが無効化されること
**Validates: Requirements 1.3, 4.3, 5.3**

接続テストが失敗したプロキシは無効化し、直接接続を使用します。これにより、使えないプロキシで接続がブロックされることを防ぎます。

### Property 4: 並列テストの早期終了

*For any* テストURLのリスト、いずれか1つでも成功すればテスト全体が成功すること
**Validates: Requirements 2.2, 2.4**

複数のテストURLを並列実行し、1つでも成功すれば即座にテストを完了します。これにより、テスト時間を最小化します。

### Property 5: 定期テストによる状態更新

*For any* プロキシ状態、定期テストの結果に基づいてプロキシのON/OFFが切り替わること
**Validates: Requirements 3.2, 3.3**

定期的にプロキシの疎通状態をチェックし、結果に応じて自動的にプロキシを有効化/無効化します。これにより、ネットワーク環境の変化に自動的に対応します。

### Property 6: プロキシURL変更時の即座のテスト

*For any* プロキシURL変更イベント、新しいプロキシに対して即座に接続テストが実行されること
**Validates: Requirements 5.1**

システムプロキシURLが変更されたら、即座に新しいプロキシをテストします。これにより、変更後すぐに正しいプロキシ状態になります。

### Property 7: 通知の重複抑制

*For any* プロキシ状態変化のシーケンス、短時間に同じ通知が複数回表示されないこと
**Validates: Requirements 6.3**

同じプロキシ状態の通知が短時間に複数回表示されることを防ぎます。これは既存のNotificationThrottlerを使用します。

### Property 8: 連続状態変化時の最終状態通知

*For any* 連続したプロキシ状態変化、最後の状態のみが通知されること
**Validates: Requirements 6.4**

連続してプロキシ状態が変化する場合、デバウンスして最後の状態のみを通知します。これにより、通知の乱発を防ぎます。

### Property 9: テスト間隔設定の範囲検証

*For any* テスト間隔の設定値、30秒から10分の範囲内に制限されること
**Validates: Requirements 8.3**

テスト間隔の設定値を検証し、範囲外の値は最小値または最大値にクランプします。

### Property 10: 設定変更時のタイマー更新

*For any* テスト間隔の変更、新しい間隔で定期テストが実行されること
**Validates: Requirements 8.2**

テスト間隔の設定が変更されたら、即座に新しい間隔でタイマーを再設定します。

## Error Handling

### エラーの分類

1. **接続エラー**: プロキシサーバーに接続できない
2. **タイムアウトエラー**: 接続テストがタイムアウト
3. **設定エラー**: 無効なテスト間隔設定

### エラー処理戦略

1. **接続エラー**:
   - テスト失敗として扱う
   - プロキシを無効化
   - エラー詳細を出力チャネルに記録
   - 自動テストの場合は簡潔な通知のみ

2. **タイムアウトエラー**:
   - テスト失敗として扱う
   - 次のテストURLを試行（並列テストの場合は他のURLの結果を待つ）
   - すべてタイムアウトした場合はプロキシを無効化

3. **設定エラー**:
   - 無効な設定値をデフォルト値にフォールバック
   - ユーザーに警告通知を表示
   - 出力チャネルにエラーを記録

### フォールバック処理

- テスト実行中にエラーが発生した場合、プロキシを無効化して直接接続を使用
- 定期テストが連続して失敗した場合、テスト間隔を徐々に延長（最大10分）
- ProxyConnectionTesterの初期化に失敗した場合、接続テストなしで動作（現在の動作を維持）

## Testing Strategy

### Unit Testing

以下のコンポーネントに対してユニットテストを実施します：

1. **ProxyConnectionTester**:
   - 自動テストの実行
   - 手動テストの実行
   - テスト結果の通知
   - テスト中フラグの管理

2. **ProxyTestScheduler**:
   - スケジューラーの開始/停止
   - テスト間隔の更新
   - プロキシURLの更新
   - 即座のテスト実行

3. **ProxyUtils (改善版)**:
   - 並列テストの実行
   - タイムアウト処理
   - テスト結果の集約

4. **ProxyMonitor (拡張版)**:
   - 接続テスト統合
   - テスト結果に基づく状態管理
   - イベント発行

### Property-Based Testing

fast-checkライブラリを使用して、以下のプロパティをテストします：

1. **Property 1: システムプロキシ検出時のテスト実行**
   - ランダムなプロキシURLを生成
   - 検出時に接続テストが呼び出されることを確認
   - 最小30回のイテレーション

2. **Property 2: テスト成功時のプロキシ有効化**
   - ランダムなプロキシURLとテスト結果（成功）を生成
   - プロキシが有効化されることを確認
   - 最小30回のイテレーション

3. **Property 3: テスト失敗時のプロキシ無効化**
   - ランダムなプロキシURLとテスト結果（失敗）を生成
   - プロキシが無効化されることを確認
   - 最小30回のイテレーション

4. **Property 4: 並列テストの早期終了**
   - ランダムな数のテストURL（1-5個）とテスト結果を生成
   - 1つでも成功すれば全体が成功することを確認
   - 最小30回のイテレーション

5. **Property 5: 定期テストによる状態更新**
   - ランダムなプロキシ状態とテスト結果を生成
   - テスト結果に基づいてプロキシ状態が更新されることを確認
   - 最小30回のイテレーション

6. **Property 6: プロキシURL変更時の即座のテスト**
   - ランダムなプロキシURL変更イベントを生成
   - 変更時に接続テストが呼び出されることを確認
   - 最小30回のイテレーション

7. **Property 7: 通知の重複抑制**
   - ランダムな通知イベントのシーケンスを生成
   - 短時間に同じ通知が複数回表示されないことを確認
   - 最小30回のイテレーション

8. **Property 8: 連続状態変化時の最終状態通知**
   - ランダムな状態変化のシーケンスを生成
   - 最後の状態のみが通知されることを確認
   - 最小30回のイテレーション

9. **Property 9: テスト間隔設定の範囲検証**
   - ランダムなテスト間隔の設定値を生成（-100〜1000秒）
   - 30秒〜600秒の範囲にクランプされることを確認
   - 最小30回のイテレーション

10. **Property 10: 設定変更時のタイマー更新**
    - ランダムなテスト間隔の変更を生成
    - 新しい間隔でタイマーが再設定されることを確認
    - 最小30回のイテレーション

各プロパティベーステストには、設計ドキュメントのプロパティ番号を参照するコメントを含めます：
```typescript
// Feature: auto-mode-proxy-testing, Property 1: システムプロキシ検出時のテスト実行
```

### Integration Testing

以下の統合テストを実施します：

1. **起動時のテストフロー**:
   - VSCode起動 → Autoモード検出 → システムプロキシ検出 → 接続テスト → プロキシ有効化/無効化

2. **定期テストフロー**:
   - 定期テスト開始 → 1分後にテスト実行 → テスト結果に基づく状態更新 → 通知表示

3. **プロキシ変更フロー**:
   - システムプロキシ変更検知 → 即座にテスト実行 → テスト結果に基づく状態更新 → 通知表示

4. **手動テストフロー**:
   - ユーザーがテストコマンド実行 → 詳細テスト実行 → 詳細結果表示

### Test Coverage Goals

- ユニットテスト: 90%以上のコードカバレッジ
- プロパティベーステスト: すべての正確性プロパティをカバー
- 統合テスト: 主要なユーザーフローをカバー

## Implementation Notes

### パフォーマンス考慮事項

1. **並列テスト**: Promise.race() を使用して、最初に成功したテストで即座に完了
2. **タイムアウト**: 自動テストは3秒、手動テストは5秒に設定
3. **テスト頻度**: デフォルト1分ごと、設定で30秒〜10分の範囲で調整可能
4. **キャッシュ**: 最後のテスト結果をキャッシュし、重複テストを避ける

### 既存機能との統合

1. **ProxyMonitor**: 既存の検出ロジックに接続テストを追加
2. **UserNotifier**: 既存の通知システムと NotificationThrottler を使用
3. **OutputChannelManager**: テスト結果の詳細を出力チャネルに記録

### 後方互換性

- 既存の ProxyMonitor の動作を変更せず、接続テスト機能を追加
- 設定項目を追加（デフォルト値で既存の動作を維持）
- 接続テストが失敗しても、拡張機能全体は動作し続ける

### 国際化

すべての通知メッセージは国際化対応します：

- 新しいメッセージキーを `src/i18n/locales/en.json` と `src/i18n/locales/ja.json` に追加
- テスト結果の通知メッセージ
- エラーメッセージ

### 設定項目

package.json に以下の設定を追加：

```json
{
  "otakProxy.testInterval": {
    "type": "number",
    "default": 60,
    "minimum": 30,
    "maximum": 600,
    "description": "Proxy connection test interval in seconds (Auto mode only)"
  },
  "otakProxy.autoTestEnabled": {
    "type": "boolean",
    "default": true,
    "description": "Enable automatic proxy connection testing in Auto mode"
  }
}
```
