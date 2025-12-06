# 設計書

## 概要

本設計は、Autoモードにおけるシステムプロキシ自動検出機能の改善を目的としています。現在の実装では1分間隔のポーリングとウィンドウフォーカス時のチェックのみですが、より頻繁なチェック、複数のトリガー、リトライ機能、詳細なログ記録、カスタマイズ可能な設定を追加することで、ネットワーク環境の変化に対する応答性と信頼性を大幅に向上させます。

**設計の根拠**: 開発者は頻繁にネットワーク環境を切り替えます（オフィス、自宅、カフェ、VPN接続など）。プロキシ設定の変更を迅速に検出して適用することで、ネットワーク切り替え時の手動設定を不要にし、開発体験を向上させます。

## アーキテクチャ

### 現在のアーキテクチャ

```
extension.ts
├── startSystemProxyMonitoring()
│   ├── 1分間隔のsetInterval
│   └── checkAndUpdateSystemProxy()
├── onDidChangeWindowState (フォーカス時)
│   └── checkAndUpdateSystemProxy()
└── SystemProxyDetector.detectSystemProxy()
```

### 改善後のアーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                     Extension Layer                          │
│  - コマンド登録                                               │
│  - イベントリスナー登録                                        │
│  - 状態管理                                                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Proxy Monitoring Layer (NEW)                    │
│  - ProxyMonitor: 統合監視マネージャー                         │
│    ├── ポーリングベース監視                                   │
│    ├── イベントベース監視                                     │
│    ├── デバウンス処理                                         │
│    └── リトライロジック                                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Detection Layer (既存)                          │
│  - SystemProxyDetector: プラットフォーム固有の検出            │
│    ├── 環境変数                                              │
│    ├── VSCode設定                                            │
│    └── プラットフォーム固有の検出                             │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              Logging & State Layer (NEW)                     │
│  - ProxyChangeLogger: 変更履歴の記録                         │
│  - ProxyMonitorState: 監視状態の管理                         │
└─────────────────────────────────────────────────────────────┘
```

**設計の根拠**: 監視機能を専用のレイヤーに分離することで、extension.tsの複雑さを軽減し、テスタビリティを向上させます。また、将来的な拡張（例：ネットワークイベントの監視）も容易になります。

## コンポーネントとインターフェース

### 1. ProxyMonitor

プロキシ監視を統合管理する新しいクラス。

```typescript
export interface ProxyMonitorConfig {
    pollingInterval: number;        // ポーリング間隔（ミリ秒）
    debounceDelay: number;          // デバウンス遅延（ミリ秒）
    maxRetries: number;             // 最大リトライ回数
    retryBackoffBase: number;       // リトライバックオフの基数（秒）
    detectionSourcePriority: string[]; // 検出ソースの優先順位
}

export interface ProxyDetectionResult {
    proxyUrl: string | null;
    source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;
    timestamp: number;
    success: boolean;
    error?: string;
}

export class ProxyMonitor {
    private config: ProxyMonitorConfig;
    private detector: SystemProxyDetector;
    private logger: ProxyChangeLogger;
    private state: ProxyMonitorState;
    private pollingInterval?: NodeJS.Timeout;
    private debounceTimer?: NodeJS.Timeout;
    private retryCount: number = 0;

    constructor(
        detector: SystemProxyDetector,
        logger: ProxyChangeLogger,
        config?: Partial<ProxyMonitorConfig>
    );

    /**
     * 監視を開始
     * ポーリングとイベントリスナーを設定
     */
    start(): void;

    /**
     * 監視を停止
     * すべてのインターバルとリスナーをクリア
     */
    stop(): void;

    /**
     * プロキシチェックをトリガー（デバウンス付き）
     * 複数のトリガーが短時間に発生した場合、最後のトリガーのみ実行
     */
    triggerCheck(source: 'polling' | 'focus' | 'config' | 'network'): void;

    /**
     * 即座にプロキシチェックを実行（デバウンスなし）
     * リトライロジック付き
     */
    private async executeCheck(): Promise<ProxyDetectionResult>;

    /**
     * リトライロジック付きでプロキシを検出
     */
    private async detectWithRetry(): Promise<ProxyDetectionResult>;

    /**
     * 設定を更新
     */
    updateConfig(config: Partial<ProxyMonitorConfig>): void;

    /**
     * 現在の監視状態を取得
     */
    getState(): ProxyMonitorState;
}
```

**設計の根拠**: ProxyMonitorクラスは、ポーリング、イベント処理、デバウンス、リトライなどの複雑なロジックをカプセル化します。これにより、extension.tsはシンプルになり、テストも容易になります。

### 2. ProxyChangeLogger

プロキシ変更履歴を記録する新しいクラス。

```typescript
export interface ProxyChangeEvent {
    timestamp: number;
    previousProxy: string | null;
    newProxy: string | null;
    source: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}

export interface ProxyCheckEvent {
    timestamp: number;
    success: boolean;
    proxyUrl: string | null;
    source: string | null;
    error?: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}

export class ProxyChangeLogger {
    private sanitizer: InputSanitizer;
    private changeHistory: ProxyChangeEvent[] = [];
    private checkHistory: ProxyCheckEvent[] = [];
    private maxHistorySize: number = 100;

    constructor(sanitizer: InputSanitizer);

    /**
     * プロキシ変更イベントを記録
     * クレデンシャルはマスクされる
     */
    logChange(event: ProxyChangeEvent): void;

    /**
     * プロキシチェックイベントを記録
     */
    logCheck(event: ProxyCheckEvent): void;

    /**
     * 変更履歴を取得
     */
    getChangeHistory(limit?: number): ProxyChangeEvent[];

    /**
     * チェック履歴を取得
     */
    getCheckHistory(limit?: number): ProxyCheckEvent[];

    /**
     * 履歴をクリア
     */
    clearHistory(): void;

    /**
     * 最後の変更イベントを取得
     */
    getLastChange(): ProxyChangeEvent | null;

    /**
     * 最後のチェックイベントを取得
     */
    getLastCheck(): ProxyCheckEvent | null;
}
```

**設計の根拠**: ログ記録を専用のクラスに分離することで、デバッグとトラブルシューティングが容易になります。また、将来的にログのエクスポート機能を追加することも可能です。

### 3. ProxyMonitorState

監視状態を管理する新しいクラス。

```typescript
export interface MonitoringStatus {
    isActive: boolean;
    lastCheckTime: number | null;
    lastSuccessTime: number | null;
    lastFailureTime: number | null;
    consecutiveFailures: number;
    currentProxy: string | null;
    detectionSource: string | null;
}

export class ProxyMonitorState {
    private status: MonitoringStatus;

    constructor();

    /**
     * チェック開始を記録
     */
    recordCheckStart(): void;

    /**
     * チェック成功を記録
     */
    recordCheckSuccess(proxyUrl: string | null, source: string | null): void;

    /**
     * チェック失敗を記録
     */
    recordCheckFailure(): void;

    /**
     * 失敗カウンターをリセット
     */
    resetFailureCount(): void;

    /**
     * 現在の状態を取得
     */
    getStatus(): MonitoringStatus;

    /**
     * 監視をアクティブに設定
     */
    setActive(active: boolean): void;
}
```

**設計の根拠**: 状態管理を専用のクラスに分離することで、状態の一貫性を保ち、テストを容易にします。

### 4. SystemProxyDetector の拡張

既存のSystemProxyDetectorクラスに、検出ソースの優先順位機能を追加します。

```typescript
export class SystemProxyDetector {
    private validator: ProxyUrlValidator;
    private detectionSourcePriority: string[];

    constructor(detectionSourcePriority?: string[]);

    /**
     * 優先順位に従ってシステムプロキシを検出
     */
    async detectSystemProxy(): Promise<string | null>;

    /**
     * 検出結果の詳細を返す（新規）
     */
    async detectSystemProxyWithSource(): Promise<{
        proxyUrl: string | null;
        source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;
    }>;

    /**
     * 検出ソースの優先順位を更新
     */
    updateDetectionPriority(priority: string[]): void;

    // 既存のメソッドは維持
    private detectFromEnvironment(): string | null;
    private detectFromVSCode(): string | null;
    private async detectFromPlatform(): Promise<string | null>;
    // ...
}
```

### 5. extension.ts の変更

既存のextension.tsに、ProxyMonitorを統合します。

```typescript
// 新しいインスタンスを追加
const proxyChangeLogger = new ProxyChangeLogger(sanitizer);
const proxyMonitor = new ProxyMonitor(
    systemProxyDetector,
    proxyChangeLogger,
    {
        pollingInterval: 30000,  // 30秒（設定から読み込み）
        debounceDelay: 1000,     // 1秒
        maxRetries: 3,
        retryBackoffBase: 1,
        detectionSourcePriority: ['environment', 'vscode', 'platform']
    }
);

// ProxyMonitorのイベントハンドラーを設定
proxyMonitor.on('proxyChanged', async (result: ProxyDetectionResult) => {
    const state = await getProxyState(context);
    if (state.mode === ProxyMode.Auto) {
        const previousProxy = state.autoProxyUrl;
        state.autoProxyUrl = result.proxyUrl || undefined;

        if (previousProxy !== state.autoProxyUrl) {
            await saveProxyState(context, state);
            await applyProxySettings(state.autoProxyUrl || '', true, context);
            updateStatusBar(state);

            if (state.autoProxyUrl) {
                userNotifier.showSuccess(
                    `System proxy changed: ${sanitizeProxyUrl(state.autoProxyUrl)}`
                );
            } else if (previousProxy) {
                userNotifier.showSuccess('System proxy removed');
            }
        }
    }
});

// activate関数内
export async function activate(context: vscode.ExtensionContext) {
    // ... 既存の初期化コード ...

    // ProxyMonitorを開始（Autoモードの場合）
    const state = await getProxyState(context);
    if (state.mode === ProxyMode.Auto) {
        proxyMonitor.start();
    }

    // 設定変更リスナーを追加
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('otakProxy.pollingInterval')) {
                const newInterval = vscode.workspace
                    .getConfiguration('otakProxy')
                    .get<number>('pollingInterval', 30);
                proxyMonitor.updateConfig({
                    pollingInterval: newInterval * 1000
                });
            }
            if (e.affectsConfiguration('otakProxy.detectionSourcePriority')) {
                const priority = vscode.workspace
                    .getConfiguration('otakProxy')
                    .get<string[]>('detectionSourcePriority', []);
                systemProxyDetector.updateDetectionPriority(priority);
            }
        })
    );

    // ... 既存のコマンド登録 ...
}

// startSystemProxyMonitoring と stopSystemProxyMonitoring を置き換え
async function startProxyMonitoring(): Promise<void> {
    proxyMonitor.start();
}

async function stopProxyMonitoring(): Promise<void> {
    proxyMonitor.stop();
}

// deactivate関数
export async function deactivate() {
    proxyMonitor.stop();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
```

### 6. ステータスバーの拡張

ステータスバーに詳細情報を表示するように、updateStatusBar関数を拡張します。

```typescript
function updateStatusBar(state: ProxyState) {
    if (!statusBarItem) {
        Logger.error('Status bar item not initialized');
        return;
    }

    const activeUrl = getActiveProxyUrl(state);
    const monitorState = proxyMonitor.getState();
    const lastCheck = proxyChangeLogger.getLastCheck();
    
    let text = '';
    let statusText = '';

    switch (state.mode) {
        case ProxyMode.Auto:
            if (activeUrl) {
                text = `$(sync~spin) Auto: ${activeUrl}`;
                statusText = `Auto Mode - Using system proxy: ${activeUrl}`;
            } else {
                text = `$(sync~spin) Auto: No system proxy`;
                statusText = `Auto Mode - No system proxy detected`;
            }
            break;
        // ... 他のモード ...
    }

    statusBarItem.text = text;

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    tooltip.appendMarkdown(`**Proxy Configuration**\n\n`);
    tooltip.appendMarkdown(`**Current Mode:** ${state.mode.toUpperCase()}\n\n`);
    tooltip.appendMarkdown(`**Status:** ${statusText}\n\n`);

    if (state.mode === ProxyMode.Auto && lastCheck) {
        const lastCheckTime = new Date(lastCheck.timestamp).toLocaleTimeString();
        tooltip.appendMarkdown(`**Last Check:** ${lastCheckTime}\n`);
        
        if (lastCheck.source) {
            tooltip.appendMarkdown(`**Detection Source:** ${lastCheck.source}\n`);
        }
        
        if (!lastCheck.success && lastCheck.error) {
            tooltip.appendMarkdown(`**Last Error:** ${lastCheck.error}\n`);
        }
        
        tooltip.appendMarkdown(`\n`);
    }

    if (state.manualProxyUrl) {
        tooltip.appendMarkdown(`**Manual Proxy:** ${state.manualProxyUrl}\n\n`);
    }
    if (state.autoProxyUrl) {
        tooltip.appendMarkdown(`**System Proxy:** ${state.autoProxyUrl}\n\n`);
    }

    tooltip.appendMarkdown(`---\n\n`);
    tooltip.appendMarkdown(`$(sync) [Toggle Mode](command:otak-proxy.toggleProxy) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(gear) [Configure Manual](command:otak-proxy.configureUrl) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(cloud-download) [Import System](command:otak-proxy.importProxy) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(debug-start) [Test Proxy](command:otak-proxy.testProxy)`);

    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}
```

## データモデル

### ProxyMonitorConfig

```typescript
export interface ProxyMonitorConfig {
    pollingInterval: number;        // デフォルト: 30000 (30秒)
    debounceDelay: number;          // デフォルト: 1000 (1秒)
    maxRetries: number;             // デフォルト: 3
    retryBackoffBase: number;       // デフォルト: 1 (秒)
    detectionSourcePriority: string[]; // デフォルト: ['environment', 'vscode', 'platform']
}
```

### ProxyDetectionResult

```typescript
export interface ProxyDetectionResult {
    proxyUrl: string | null;
    source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;
    timestamp: number;
    success: boolean;
    error?: string;
}
```

### ProxyChangeEvent

```typescript
export interface ProxyChangeEvent {
    timestamp: number;
    previousProxy: string | null;
    newProxy: string | null;
    source: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}
```

### ProxyCheckEvent

```typescript
export interface ProxyCheckEvent {
    timestamp: number;
    success: boolean;
    proxyUrl: string | null;
    source: string | null;
    error?: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}
```

### MonitoringStatus

```typescript
export interface MonitoringStatus {
    isActive: boolean;
    lastCheckTime: number | null;
    lastSuccessTime: number | null;
    lastFailureTime: number | null;
    consecutiveFailures: number;
    currentProxy: string | null;
    detectionSource: string | null;
}
```

## 正確性プロパティ

*プロパティとは、システムのすべての有効な実行において真であるべき特性や動作のことです。これは、人間が読める仕様と機械で検証可能な正確性保証の橋渡しとなります。*

### プロパティ反映

事前分析を確認した結果、以下の冗長性を特定しました:

- プロパティ2.1、2.2、2.3は特定のトリガーの例であり、プロパティ2.4のデバウンス機能で包含される
- プロパティ5.1、5.2、5.3、5.4はUI表示の例であり、統合テストで検証可能

### 正確性プロパティ

**プロパティ1: ポーリング間隔の遵守**
*任意の*有効なポーリング間隔（10秒から300秒）に対して、Autoモードが有効な場合、システムはその間隔でプロキシチェックを実行するべき
**検証対象: 要件 1.1**

**プロパティ2: ポーリング間隔の動的更新**
*任意の*有効なポーリング間隔に対して、設定を変更した場合、システムは既存のインターバルをクリアして新しい間隔でチェックを開始するべき
**検証対象: 要件 1.2**

**プロパティ3: チェック失敗時の継続**
*任意の*チェック失敗に対して、システムはエラーをログに記録し、次回のポーリングを継続するべき
**検証対象: 要件 1.3**

**プロパティ4: モード切り替え時のポーリング停止**
*任意の*Autoモード以外のモード（Manual、Off）に対して、モードを切り替えた場合、システムはポーリングを停止するべき
**検証対象: 要件 1.4**

**プロパティ5: デバウンス処理**
*任意の*複数のトリガーイベントに対して、デバウンス期間（1秒）内に発生した場合、システムは1回のみチェックを実行するべき
**検証対象: 要件 2.4**

**プロパティ6: リトライ回数の遵守**
*任意の*検出失敗に対して、システムは設定された最大リトライ回数（デフォルト3回）まで再試行するべき
**検証対象: 要件 3.1**

**プロパティ7: 指数バックオフ**
*任意の*リトライ試行に対して、待機時間は指数的に増加する（1秒、2秒、4秒...）べき
**検証対象: 要件 3.2**

**プロパティ8: リトライ成功時のリセット**
*任意の*リトライ成功に対して、システムは検出されたプロキシを適用し、リトライカウンターを0にリセットするべき
**検証対象: 要件 3.4**

**プロパティ9: プロキシ変更のログ記録**
*任意の*プロキシ変更（previousProxy ≠ newProxy）に対して、システムは変更前と変更後のURLをログに記録するべき
**検証対象: 要件 4.1**

**プロパティ10: チェック実行のログ記録**
*任意の*プロキシチェック実行に対して、システムはチェック時刻、結果、検出ソースをログに記録するべき
**検証対象: 要件 4.3**

**プロパティ11: ログ記録時のクレデンシャルマスキング**
*任意の*クレデンシャル付きプロキシURLに対して、ログに記録される値はInputSanitizerでマスクされているべき
**検証対象: 要件 4.4**

**プロパティ12: ポーリング間隔の範囲検証**
*任意の*ポーリング間隔値に対して、10秒から300秒の範囲内であれば受け入れ、範囲外であればデフォルト値（30秒）を使用するべき
**検証対象: 要件 6.2, 6.3**

**プロパティ13: 設定変更の即時適用**
*任意の*有効な設定値に対して、設定を変更した場合、システムは即座に新しい設定を適用するべき
**検証対象: 要件 6.4**

**プロパティ14: 検出ソースの優先順位遵守**
*任意の*検出ソース優先順位リストに対して、システムはリストの順序に従ってソースをチェックするべき
**検証対象: 要件 7.1**

**プロパティ15: 検出失敗時のフォールバック**
*任意の*検出ソース優先順位リストに対して、優先順位の高いソースで失敗した場合、システムは次のソースを試行するべき
**検証対象: 要件 7.2, 7.4**

### エッジケースと例

**例1: ウィンドウフォーカス時のチェック**
VSCodeウィンドウがフォーカスを取得した場合、システムはプロキシチェックをトリガーする
**検証対象: 要件 2.1**

**例2: ネットワーク変化時のチェック**
ネットワーク接続状態が変化した場合、システムはプロキシチェックをトリガーする
**検証対象: 要件 2.2**

**例3: 設定変更時のチェック**
設定ファイルが変更された場合、システムはプロキシチェックをトリガーする
**検証対象: 要件 2.3**

**例4: 全リトライ失敗時の通知**
すべてのリトライが失敗した場合、システムはエラーをログに記録し、ユーザーに通知する
**検証対象: 要件 3.3**

**例5: プロキシ削除のログ記録**
プロキシが検出されなくなった場合（newProxy = null）、システムはプロキシ削除イベントをログに記録する
**検証対象: 要件 4.2**

**例6: 全ソース失敗時のnull返却**
すべての検出ソースで失敗した場合、システムはnullを返す
**検証対象: 要件 7.3**

## エラーハンドリング

### エラーカテゴリ

1. **検出エラー**: システムプロキシの検出に失敗
   - 対応: リトライロジックを実行、すべて失敗した場合はログ記録とユーザー通知
   - ユーザーアクション: システムプロキシ設定を確認、または手動設定に切り替え

2. **設定エラー**: 無効な設定値
   - 対応: デフォルト値を使用、警告をログに記録
   - ユーザーアクション: 設定値を有効な範囲内に修正

3. **タイムアウトエラー**: 検出処理がタイムアウト
   - 対応: リトライロジックを実行
   - ユーザーアクション: システムの応答性を確認

4. **状態エラー**: 監視状態の不整合
   - 対応: 状態をリセット、エラーをログに記録
   - ユーザーアクション: 拡張機能を再起動

### エラーメッセージフォーマット

すべてのエラーメッセージは以下の構造に従います:

```
[操作] failed: [具体的な理由]

What happened:
- [詳細1]
- [詳細2]

Suggestions:
- [アクション1]
- [アクション2]
```

例:
```
System proxy detection failed: All detection sources failed

What happened:
- Environment variables: No proxy configured
- VSCode settings: No proxy configured
- Platform detection: Registry query failed

Suggestions:
- Check your system/browser proxy settings
- Verify proxy is enabled in system settings
- Try configuring a manual proxy instead
- Check the extension output log for details
```

### エラーリカバリー戦略

1. **リトライロジック**: 一時的なエラーに対して指数バックオフでリトライ
2. **グレースフルデグラデーション**: 検出失敗時も拡張機能は動作継続
3. **状態リセット**: 連続失敗が一定回数を超えた場合、状態をリセット
4. **ユーザー通知**: 重大なエラーのみユーザーに通知、軽微なエラーはログのみ

## テスト戦略

### ユニットテスト

各コンポーネントの基本機能をテストします:

1. **ProxyMonitor**:
   - start()とstop()の動作
   - ポーリング間隔の設定と変更
   - デバウンス処理
   - リトライロジック

2. **ProxyChangeLogger**:
   - イベントの記録
   - 履歴の取得
   - クレデンシャルマスキング
   - 履歴サイズの制限

3. **ProxyMonitorState**:
   - 状態の記録と取得
   - 失敗カウンターの管理
   - 状態のリセット

4. **SystemProxyDetector拡張**:
   - 優先順位に従った検出
   - 検出ソースの情報返却
   - 優先順位の動的更新

### プロパティベーステスト

fast-checkライブラリを使用して、以下のプロパティを検証します:

- **最小イテレーション数**: 各プロパティテストは最低100回実行
- **ジェネレーター**: `src/test/generators.ts`を拡張して監視設定用のジェネレーターを追加
- **タグ付け**: 各プロパティテストに設計書のプロパティ番号を明記

```typescript
// 例: プロパティ1のテスト
/**
 * Feature: auto-proxy-detection-improvements, Property 1: ポーリング間隔の遵守
 * 任意の有効なポーリング間隔（10秒から300秒）に対して、Autoモードが有効な場合、
 * システムはその間隔でプロキシチェックを実行するべき
 */
test('Property 1: Polling interval adherence', async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.integer({ min: 10, max: 300 }),
            async (intervalSeconds) => {
                const monitor = new ProxyMonitor(
                    mockDetector,
                    mockLogger,
                    { pollingInterval: intervalSeconds * 1000 }
                );
                
                monitor.start();
                
                // 間隔の2倍待機してチェック回数を確認
                await sleep(intervalSeconds * 2000);
                
                const checkCount = mockDetector.getCheckCount();
                expect(checkCount).toBeGreaterThanOrEqual(1);
                expect(checkCount).toBeLessThanOrEqual(3);
                
                monitor.stop();
            }
        ),
        { numRuns: 100 }
    );
});

// 例: プロパティ5のテスト
/**
 * Feature: auto-proxy-detection-improvements, Property 5: デバウンス処理
 * 任意の複数のトリガーイベントに対して、デバウンス期間（1秒）内に発生した場合、
 * システムは1回のみチェックを実行するべき
 */
test('Property 5: Debounce processing', async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.integer({ min: 2, max: 10 }),
            async (triggerCount) => {
                const monitor = new ProxyMonitor(
                    mockDetector,
                    mockLogger,
                    { debounceDelay: 1000 }
                );
                
                monitor.start();
                
                // 短時間に複数のトリガーを発生
                for (let i = 0; i < triggerCount; i++) {
                    monitor.triggerCheck('focus');
                    await sleep(100); // 100ms間隔
                }
                
                // デバウンス期間後に確認
                await sleep(1500);
                
                const checkCount = mockDetector.getCheckCount();
                expect(checkCount).toBe(1);
                
                monitor.stop();
            }
        ),
        { numRuns: 100 }
    );
});
```

### 統合テスト

エンドツーエンドのワークフローを検証します:

1. **Autoモード有効化フロー**: モード切り替え → 監視開始 → プロキシ検出 → 設定適用
2. **プロキシ変更検出フロー**: プロキシ変更 → 検出 → ログ記録 → 設定適用 → ユーザー通知
3. **設定変更フロー**: 設定変更 → 監視設定更新 → 新しい設定で動作
4. **エラーリカバリーフロー**: 検出失敗 → リトライ → 成功 → 状態リセット

### テストカバレッジ目標

- **ライン カバレッジ**: 最低85%
- **ブランチ カバレッジ**: 最低80%
- **プロパティ カバレッジ**: 正確性プロパティの100%に対応するテストが必要
- **プラットフォーム カバレッジ**: プラットフォーム固有のコードは各プラットフォームでテスト

## 実装フェーズ

### フェーズ1: コアコンポーネント（高優先度）
- ProxyMonitorクラスの実装
- ProxyChangeLoggerクラスの実装
- ProxyMonitorStateクラスの実装
- 基本的なユニットテストの作成
- **リスク**: 複雑なロジック（デバウンス、リトライ）の実装ミス

### フェーズ2: SystemProxyDetector拡張（中優先度）
- 検出ソース優先順位機能の追加
- detectSystemProxyWithSource()メソッドの実装
- 優先順位の動的更新機能
- **リスク**: 既存の検出ロジックへの影響

### フェーズ3: extension.ts統合（高優先度）
- ProxyMonitorのextension.tsへの統合
- 既存のstartSystemProxyMonitoring()の置き換え
- イベントリスナーの設定
- ステータスバーの拡張
- **リスク**: 既存機能の破壊

### フェーズ4: 設定とUI（中優先度）
- package.jsonへの設定項目追加
- 設定変更リスナーの実装
- ステータスバーツールチップの拡張
- **リスク**: ユーザー体験への影響

### フェーズ5: テストと検証（高優先度）
- プロパティベーステストの実装
- 統合テストの実装
- 各プラットフォームでの手動テスト
- パフォーマンステスト
- **リスク**: プラットフォーム固有の問題

## パフォーマンス考慮事項

### ポーリング頻度
- デフォルト30秒間隔は、応答性とシステム負荷のバランスを考慮
- ユーザーが10秒まで短縮可能だが、CPU使用率への影響を警告

### デバウンス処理
- 1秒のデバウンス遅延により、短時間の複数トリガーを効率的に処理
- メモリ使用量への影響は最小限（タイマー1つのみ）

### ログ履歴
- 最大100イベントに制限してメモリ使用量を抑制
- 古いイベントは自動的に削除

### リトライロジック
- 指数バックオフにより、連続失敗時のシステム負荷を軽減
- 最大3回のリトライで、過度な遅延を防止

### Node.js非依存の実装
- VSCode拡張機能はNode.js環境で動作するため、Node.js APIは利用可能
- ただし、ユーザーのシステムにNode.jsがインストールされている必要はない
- すべての機能はVSCode組み込みのNode.js環境で動作

## セキュリティ考慮事項

### クレデンシャル保護
- すべてのログ記録でInputSanitizerを使用
- ProxyChangeLoggerは自動的にクレデンシャルをマスク
- ステータスバーにもマスクされたURLのみ表示

### 検出ソースの信頼性
- 検出されたプロキシURLは既存のProxyUrlValidatorで検証
- 無効なURLは拒否され、次のソースを試行

### 設定値の検証
- ポーリング間隔は10秒から300秒の範囲に制限
- 無効な値はデフォルト値で置き換え

## 互換性

### 既存機能との互換性
- 既存のstartSystemProxyMonitoring()とstopSystemProxyMonitoring()を置き換え
- ProxyStateインターフェースは変更なし
- 既存のSystemProxyDetectorは拡張のみ、破壊的変更なし

### 設定の後方互換性
- 新しい設定項目はすべてオプショナル
- デフォルト値により、既存ユーザーへの影響なし

### VSCodeバージョン
- VSCode 1.9.0以降をサポート（既存の要件と同じ）

### Node.js環境
- VSCode拡張機能はVSCode組み込みのNode.js環境で動作
- ユーザーのシステムにNode.jsがインストールされている必要はない
- すべてのNode.js APIはVSCode内で利用可能

## 今後の拡張性

### ネットワークイベント監視
- Node.jsのネットワークイベントAPIを使用して、ネットワーク変化を直接検出
- ProxyMonitorに新しいトリガーソースとして追加可能

### プロキシ検出プラグイン
- カスタム検出ソースをプラグインとして追加可能な仕組み
- 企業固有のプロキシ設定に対応

### 統計情報の収集
- プロキシ変更頻度、検出成功率などの統計情報を収集
- トラブルシューティングとパフォーマンス改善に活用

### ログのエクスポート
- ProxyChangeLoggerの履歴をファイルにエクスポート
- デバッグとサポートに活用

## 設定項目

package.jsonに以下の設定項目を追加します:

```json
{
  "contributes": {
    "configuration": {
      "title": "Otak Proxy",
      "properties": {
        "otakProxy.pollingInterval": {
          "type": "number",
          "default": 30,
          "minimum": 10,
          "maximum": 300,
          "description": "Auto mode polling interval in seconds (10-300)"
        },
        "otakProxy.detectionSourcePriority": {
          "type": "array",
          "default": ["environment", "vscode", "platform"],
          "items": {
            "type": "string",
            "enum": ["environment", "vscode", "platform"]
          },
          "description": "Priority order for proxy detection sources"
        },
        "otakProxy.maxRetries": {
          "type": "number",
          "default": 3,
          "minimum": 0,
          "maximum": 10,
          "description": "Maximum number of retries for proxy detection"
        }
      }
    }
  }
}
```
