# Design Document

## Overview

このドキュメントは、otak-proxy拡張機能のAutoモードにおけるフォールバック機能と状態管理の改善設計を定義します。現在の実装では、システムプロキシが検出されない場合、Autoモードは単にプロキシを無効化します。この設計では、Manualモードで設定されたプロキシURLをフォールバックとして使用し、より柔軟なプロキシ管理を実現します。

また、Autoモード内でのプロキシ無効化（Auto Mode OFF）と完全なOFFモードを明確に区別し、ユーザーが状態を理解しやすくします。

主要な改善点：

1. **フォールバックプロキシ機能**: システムプロキシが検出されない場合、Manualプロキシを試行
2. **優先順位ベースの選択**: システムプロキシ → Manualプロキシ → 直接接続
3. **状態の明確化**: Auto Mode OFFと完全なOFFモードを区別
4. **定期テストの拡張**: フォールバックプロキシも定期的にテスト
5. **設定可能なフォールバック**: ユーザーがフォールバック機能を無効化可能

## Architecture

### 既存のコンポーネント（拡張対象）

- **ProxyMonitor**: システムプロキシの監視とテスト実行（フォールバックロジックを追加）
- **ProxyConnectionTester**: プロキシ接続テスト（既存機能を使用）
- **ProxyStateManager**: プロキシ状態管理（新しいフィールドを追加）
- **StatusBarManager**: ステータスバー表示（フォールバック状態の表示を追加）
- **UserNotifier**: 通知管理（フォールバック関連の通知を追加）

### 新規コンポーネント

- **ProxyFallbackManager**: フォールバックロジックを管理する新しいクラス

### コンポーネント間の関係

```
ProxyMonitor
  ├─> ProxyFallbackManager (フォールバックロジック)
  │   ├─> ProxyConnectionTester (接続テスト)
  │   └─> ProxyStateManager (状態取得)
  └─> ProxyTestScheduler (定期テスト)

ProxyFallbackManager
  ├─> ProxyConnectionTester (プロキシテスト)
  ├─> ProxyStateManager (Manualプロキシ取得)
  └─> UserNotifier (フォールバック通知)

StatusBarManager
  └─> ProxyState (フォールバック状態を表示)
```

## Components and Interfaces

### ProxyFallbackManager

フォールバックロジックを管理する新しいクラス。

```typescript
export class ProxyFallbackManager {
    private connectionTester: ProxyConnectionTester;
    private stateManager: ProxyStateManager;
    private userNotifier: UserNotifier;
    private fallbackEnabled: boolean;
    
    constructor(
        connectionTester: ProxyConnectionTester,
        stateManager: ProxyStateManager,
        userNotifier: UserNotifier,
        fallbackEnabled: boolean = true
    );
    
    // システムプロキシとフォールバックプロキシを試行
    async selectBestProxy(systemProxyUrl: string | null): Promise<ProxySelectionResult>;
    
    // フォールバック機能の有効/無効を設定
    setFallbackEnabled(enabled: boolean): void;
    
    // フォールバック機能が有効かどうかを取得
    isFallbackEnabled(): boolean;
    
    // 内部メソッド
    private async testSystemProxy(proxyUrl: string): Promise<TestResult>;
    private async testManualProxy(): Promise<TestResult | null>;
    private notifyFallbackUsage(proxyUrl: string): void;
    private notifyFallbackFailed(): void;
}

interface ProxySelectionResult {
    proxyUrl: string | null;
    source: 'system' | 'fallback' | 'none';
    testResult?: TestResult;
    success: boolean;
}
```

### ProxyState の拡張

既存の ProxyState に新しいフィールドを追加。

```typescript
interface ProxyState {
    // 既存のフィールド
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    lastTestResult?: ProxyTestResult;
    proxyReachable?: boolean;
    lastTestTimestamp?: number;
    
    // 新しいフィールド
    usingFallbackProxy?: boolean;        // フォールバックプロキシを使用中か
    autoModeOff?: boolean;               // Auto Mode OFFの状態か
    lastSystemProxyUrl?: string;         // 最後に検出されたシステムプロキシURL
    fallbackProxyUrl?: string;           // 現在使用中のフォールバックプロキシURL
}
```

### ProxyMonitor の拡張

既存の ProxyMonitor にフォールバック機能を統合。

```typescript
export class ProxyMonitor extends EventEmitter {
    // 既存のフィールド
    private connectionTester?: ProxyConnectionTester;
    private testScheduler?: ProxyTestScheduler;
    
    // 新しいフィールド
    private fallbackManager?: ProxyFallbackManager;
    
    // executeCheck メソッドを拡張
    private async executeCheck(trigger: string): Promise<ProxyDetectionResult> {
        // システムプロキシを検出
        const detection = await this.detectProxy();
        
        // フォールバックマネージャーを使用してベストなプロキシを選択
        if (this.fallbackManager) {
            const selection = await this.fallbackManager.selectBestProxy(detection.proxyUrl);
            
            return {
                proxyUrl: selection.proxyUrl,
                source: selection.source === 'system' ? detection.source : 'fallback',
                timestamp: Date.now(),
                success: selection.success,
                testResult: selection.testResult,
                usingFallback: selection.source === 'fallback'
            };
        }
        
        // フォールバックマネージャーがない場合は既存のロジック
        // ...
    }
}
```

### StatusBarManager の拡張

ステータスバーにフォールバック状態を表示。

```typescript
export class StatusBarManager {
    // 既存のメソッドを拡張
    updateText(state: ProxyState): void {
        const i18n = I18nManager.getInstance();
        
        switch (state.mode) {
            case ProxyMode.Auto:
                if (state.autoModeOff) {
                    this.statusBarItem.text = `$(circle-slash) ${i18n.t('status.autoOff')}`;
                } else if (state.usingFallbackProxy) {
                    this.statusBarItem.text = `$(plug) ${i18n.t('status.autoFallback')}`;
                } else {
                    this.statusBarItem.text = `$(plug) ${i18n.t('status.auto')}`;
                }
                break;
            case ProxyMode.Off:
                this.statusBarItem.text = `$(circle-slash) ${i18n.t('status.off')}`;
                break;
            // ...
        }
    }
    
    updateTooltip(state: ProxyState): void {
        const i18n = I18nManager.getInstance();
        
        if (state.mode === ProxyMode.Auto) {
            if (state.autoModeOff) {
                this.statusBarItem.tooltip = i18n.t('tooltip.autoOff');
            } else if (state.usingFallbackProxy) {
                this.statusBarItem.tooltip = i18n.t('tooltip.autoFallback', {
                    url: state.fallbackProxyUrl || ''
                });
            }
        }
        // ...
    }
}
```

## Data Models

### ProxySelectionResult

プロキシ選択結果を表すインターフェース。

```typescript
interface ProxySelectionResult {
    proxyUrl: string | null;           // 選択されたプロキシURL
    source: 'system' | 'fallback' | 'none'; // プロキシのソース
    testResult?: TestResult;           // テスト結果
    success: boolean;                  // 選択が成功したか
}
```

### ProxyDetectionResult の拡張

既存の ProxyDetectionResult に新しいフィールドを追加。

```typescript
interface ProxyDetectionResult {
    // 既存のフィールド
    proxyUrl: string | null;
    source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | 'fallback' | null;
    timestamp: number;
    success: boolean;
    error?: string;
    testResult?: TestResult;
    proxyReachable?: boolean;
    
    // 新しいフィールド
    usingFallback?: boolean;           // フォールバックプロキシを使用中か
}
```

### Configuration

フォールバック機能の設定。

```typescript
// package.json の configuration セクションに追加
{
    "otakProxy.enableFallback": {
        "type": "boolean",
        "default": true,
        "description": "Enable fallback to manual proxy when system proxy is not detected (Auto mode only)"
    }
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: フォールバックプロキシの確認と選択

*For any* Autoモードの状態、システムプロキシが検出されない場合、ManualプロキシURLの存在を確認し、存在する場合は接続テストを実行し、存在しない場合はプロキシを無効化すること
**Validates: Requirements 1.1, 1.2, 1.5**

システムプロキシが検出されない場合、Manualプロキシをフォールバックとして試行します。Manualプロキシが存在しない場合は、直接接続を使用します。

### Property 2: 優先順位ベースのプロキシ選択

*For any* プロキシ選択の状況、システムは以下の優先順位でプロキシを選択すること：1) システムプロキシ（利用可能な場合）、2) Manualプロキシ（フォールバック、利用可能な場合）、3) 直接接続
**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

プロキシ選択は常に優先順位に従います。システムプロキシが利用可能な場合は常にそれを優先し、利用不可の場合のみフォールバックを試行します。

### Property 3: フォールバック使用時の通知

*For any* フォールバックプロキシが使用される状況、「システムプロキシが検出されないため、Manualプロキシを使用しています」という通知が表示されること
**Validates: Requirements 2.1**

フォールバックプロキシが使用される場合、ユーザーに明確に通知します。

### Property 4: ステータスバー表示の正確性

*For any* プロキシ状態、ステータスバーは以下のように表示されること：Auto Mode OFFの場合は「Auto (OFF)」、フォールバック使用中の場合は「Auto (Fallback)」、完全なOFFモードの場合は「OFF」
**Validates: Requirements 2.2, 4.1, 4.2**

ステータスバーの表示は、現在のプロキシ状態を正確に反映します。

### Property 5: システムプロキシへの切り替え通知

*For any* フォールバックプロキシからシステムプロキシへの切り替え、「システムプロキシに切り替えました」という通知が表示されること
**Validates: Requirements 2.3**

システムプロキシが再び利用可能になった場合、ユーザーに通知します。

### Property 6: フォールバック失敗通知

*For any* フォールバックプロキシのテスト失敗、「Manualプロキシも利用できません」という通知が表示されること
**Validates: Requirements 2.4**

フォールバックプロキシも利用できない場合、ユーザーに通知します。

### Property 7: Auto Mode OFF状態管理

*For any* Autoモードでのプロキシ無効化、状態は「Auto Mode OFF」として記録されること
**Validates: Requirements 3.1**

Autoモードでプロキシが無効化された場合、完全なOFFモードとは区別して記録します。

### Property 8: Auto Mode OFFからの自動復帰

*For any* Auto Mode OFFの状態、システムプロキシまたはフォールバックプロキシが利用可能になった場合、自動的にプロキシを有効化すること
**Validates: Requirements 3.2, 3.3**

Auto Mode OFFは一時的な状態であり、プロキシが再び利用可能になれば自動的に有効化されます。

### Property 9: 完全なOFFモードの動作

*For any* 完全なOFFモードの状態、プロキシ検出やテストは一切実行されないこと
**Validates: Requirements 3.4**

完全なOFFモードでは、プロキシ関連の処理を一切実行しません。

### Property 10: ツールチップの説明

*For any* ステータスバーのツールチップ表示、Auto Mode OFFと完全なOFFモードの違いが説明されること
**Validates: Requirements 4.3**

ツールチップは、各モードの意味を明確に説明します。

### Property 11: Auto Mode OFFでのクリック動作

*For any* Auto Mode OFFの状態でのステータスバークリック、即座に接続テストが実行されること
**Validates: Requirements 4.4**

Auto Mode OFFの状態でユーザーがステータスバーをクリックした場合、即座に接続テストを実行してプロキシの利用可能性を確認します。

### Property 12: 定期テストのフォールバックロジック

*For any* 定期テストの実行、システムプロキシを最初にテストし、失敗した場合はManualプロキシをテストし、結果に応じてプロキシを有効化/無効化すること
**Validates: Requirements 6.1, 6.2, 6.3, 6.4**

定期テストは、システムプロキシとフォールバックプロキシの両方をテストし、利用可能なプロキシを自動的に選択します。

### Property 13: フォールバック使用のログ記録

*For any* フォールバックプロキシの使用、ログに「Fallback to Manual Proxy」と記録されること
**Validates: Requirements 7.2**

フォールバックプロキシが使用される場合、ログに明確に記録します。

### Property 14: Auto Mode OFFのログ記録

*For any* Auto Mode OFFへの切り替え、ログに「Auto Mode OFF (waiting for proxy)」と記録されること
**Validates: Requirements 7.3**

Auto Mode OFFに切り替わる場合、ログに記録します。

### Property 15: システムプロキシ復帰のログ記録

*For any* システムプロキシへの復帰、ログに「Switched back to System Proxy」と記録されること
**Validates: Requirements 7.4**

フォールバックプロキシからシステムプロキシに戻る場合、ログに記録します。

### Property 16: フォールバック機能の無効化

*For any* フォールバック機能が無効化されている状態、Manualプロキシはフォールバックとして使用されず、システムプロキシのみがテストされること
**Validates: Requirements 8.2, 8.3**

フォールバック機能が無効化されている場合、Manualプロキシは試行されません。

### Property 17: フォールバック設定の即時反映

*For any* フォールバック設定の変更、新しい設定が即座に適用されること
**Validates: Requirements 8.4**

フォールバック設定が変更された場合、即座に新しい設定が反映されます。


## Error Handling

### エラーの分類

1. **フォールバックプロキシテストエラー**: フォールバックプロキシの接続テストが失敗
2. **状態管理エラー**: ProxyStateの保存/読み込みが失敗
3. **設定エラー**: フォールバック設定の読み込みが失敗

### エラー処理戦略

1. **フォールバックプロキシテストエラー**:
   - テスト失敗として扱う
   - Auto Mode OFFに切り替え
   - ユーザーに通知（「Manualプロキシも利用できません」）
   - ログに詳細を記録

2. **状態管理エラー**:
   - 既存のin-memoryフォールバックを使用
   - ユーザーに警告通知を表示
   - ログにエラーを記録

3. **設定エラー**:
   - デフォルト値（フォールバック有効）を使用
   - ログに警告を記録
   - 拡張機能は動作を継続

### フォールバック処理

- フォールバックプロキシのテストが失敗した場合、Auto Mode OFFに切り替えて直接接続を使用
- ProxyFallbackManagerの初期化に失敗した場合、フォールバック機能なしで動作（既存の動作を維持）
- 設定の読み込みに失敗した場合、デフォルト設定（フォールバック有効）を使用

## Testing Strategy

### Unit Testing

以下のコンポーネントに対してユニットテストを実施します：

1. **ProxyFallbackManager**:
   - selectBestProxy メソッドのテスト
   - システムプロキシとManualプロキシの優先順位テスト
   - フォールバック機能の有効/無効切り替えテスト
   - 通知メッセージのテスト

2. **ProxyMonitor (拡張版)**:
   - フォールバックマネージャーの統合テスト
   - executeCheck メソッドのフォールバックロジックテスト
   - 状態変化イベントのテスト

3. **ProxyStateManager (拡張版)**:
   - 新しいフィールドの保存と読み込みテスト
   - 後方互換性のテスト

4. **StatusBarManager (拡張版)**:
   - フォールバック状態の表示テスト
   - Auto Mode OFFの表示テスト
   - ツールチップのテスト

### Property-Based Testing

fast-checkライブラリを使用して、以下のプロパティをテストします：

1. **Property 1: フォールバックプロキシの確認と選択**
   - ランダムなシステムプロキシ検出結果（null）とManualプロキシURLを生成
   - フォールバックロジックが正しく動作することを確認
   - 最小100回のイテレーション

2. **Property 2: 優先順位ベースのプロキシ選択**
   - ランダムなシステムプロキシとManualプロキシの組み合わせを生成
   - 優先順位に従ってプロキシが選択されることを確認
   - 最小100回のイテレーション

3. **Property 3: フォールバック使用時の通知**
   - ランダムなフォールバックプロキシ使用状況を生成
   - 通知が表示されることを確認
   - 最小100回のイテレーション

4. **Property 4: ステータスバー表示の正確性**
   - ランダムなプロキシ状態を生成
   - ステータスバーの表示が正しいことを確認
   - 最小100回のイテレーション

5. **Property 5: システムプロキシへの切り替え通知**
   - ランダムなフォールバックからシステムプロキシへの遷移を生成
   - 通知が表示されることを確認
   - 最小100回のイテレーション

6. **Property 6: フォールバック失敗通知**
   - ランダムなフォールバックプロキシのテスト失敗を生成
   - 通知が表示されることを確認
   - 最小100回のイテレーション

7. **Property 7: Auto Mode OFF状態管理**
   - ランダムなAutoモードでのプロキシ無効化を生成
   - 状態が正しく記録されることを確認
   - 最小100回のイテレーション

8. **Property 8: Auto Mode OFFからの自動復帰**
   - ランダムなAuto Mode OFFからの復帰シナリオを生成
   - プロキシが自動的に有効化されることを確認
   - 最小100回のイテレーション

9. **Property 9: 完全なOFFモードの動作**
   - ランダムな完全なOFFモードの状態を生成
   - プロキシ検出やテストが実行されないことを確認
   - 最小100回のイテレーション

10. **Property 10: ツールチップの説明**
    - ランダムなプロキシ状態を生成
    - ツールチップが正しい説明を含むことを確認
    - 最小100回のイテレーション

11. **Property 11: Auto Mode OFFでのクリック動作**
    - ランダムなAuto Mode OFFの状態を生成
    - クリック時に接続テストが実行されることを確認
    - 最小100回のイテレーション

12. **Property 12: 定期テストのフォールバックロジック**
    - ランダムな定期テストのシナリオを生成
    - フォールバックロジックが正しく動作することを確認
    - 最小100回のイテレーション

13. **Property 13: フォールバック使用のログ記録**
    - ランダムなフォールバックプロキシの使用を生成
    - ログメッセージが正しいことを確認
    - 最小100回のイテレーション

14. **Property 14: Auto Mode OFFのログ記録**
    - ランダムなAuto Mode OFFへの切り替えを生成
    - ログメッセージが正しいことを確認
    - 最小100回のイテレーション

15. **Property 15: システムプロキシ復帰のログ記録**
    - ランダムなシステムプロキシへの復帰を生成
    - ログメッセージが正しいことを確認
    - 最小100回のイテレーション

16. **Property 16: フォールバック機能の無効化**
    - ランダムなフォールバック無効の状態を生成
    - Manualプロキシが使用されないことを確認
    - 最小100回のイテレーション

17. **Property 17: フォールバック設定の即時反映**
    - ランダムなフォールバック設定の変更を生成
    - 新しい設定が即座に適用されることを確認
    - 最小100回のイテレーション

各プロパティベーステストには、設計ドキュメントのプロパティ番号を参照するコメントを含めます：
```typescript
// Feature: auto-mode-fallback-improvements, Property 1: フォールバックプロキシの確認と選択
```

### Integration Testing

以下の統合テストを実施します：

1. **フォールバックプロキシ使用フロー**:
   - システムプロキシ検出失敗 → Manualプロキシ確認 → 接続テスト → フォールバックプロキシ有効化 → 通知表示

2. **システムプロキシ復帰フロー**:
   - フォールバックプロキシ使用中 → システムプロキシ検出 → 接続テスト → システムプロキシ有効化 → 通知表示

3. **Auto Mode OFF フロー**:
   - 両方のプロキシ失敗 → Auto Mode OFF → システムプロキシ検出 → 自動復帰 → プロキシ有効化

4. **フォールバック機能無効化フロー**:
   - フォールバック無効設定 → システムプロキシ検出失敗 → Manualプロキシを試行しない → Auto Mode OFF

### Test Coverage Goals

- ユニットテスト: 90%以上のコードカバレッジ
- プロパティベーステスト: すべての正確性プロパティをカバー
- 統合テスト: 主要なユーザーフローをカバー

## Implementation Notes

### パフォーマンス考慮事項

1. **フォールバックテストの最適化**: システムプロキシのテストが失敗した場合のみフォールバックプロキシをテスト
2. **キャッシュの活用**: 最後のテスト結果をキャッシュし、短時間での重複テストを避ける
3. **並列テスト**: システムプロキシとフォールバックプロキシのテストは並列実行しない（優先順位に従って順次実行）

### 既存機能との統合

1. **ProxyMonitor**: 既存の接続テスト機能にフォールバックロジックを追加
2. **ProxyConnectionTester**: 既存のテスト機能をそのまま使用
3. **ProxyStateManager**: 新しいフィールドを追加し、後方互換性を維持
4. **StatusBarManager**: 既存の表示ロジックにフォールバック状態を追加

### 後方互換性

- 既存の ProxyState に新しいフィールドを追加（オプショナル）
- 古い状態ファイルからの透過的な移行
- フォールバック機能が無効化されている場合、既存の動作を維持

### 国際化

すべての通知メッセージとUI表示は国際化対応します：

- 新しいメッセージキーを `src/i18n/locales/en.json` と `src/i18n/locales/ja.json` に追加
- フォールバック関連の通知メッセージ
- ステータスバーの表示テキスト
- ツールチップの説明

### 設定項目

package.json に以下の設定を追加：

```json
{
  "otakProxy.enableFallback": {
    "type": "boolean",
    "default": true,
    "description": "Enable fallback to manual proxy when system proxy is not detected (Auto mode only)",
    "description.ja": "システムプロキシが検出されない場合、手動プロキシにフォールバックする（Autoモードのみ）"
  }
}
```

## Design Decisions

### なぜフォールバック機能を追加するのか

システムプロキシが検出されない環境（例：自宅）でも、ユーザーが設定したManualプロキシが利用可能な場合があります。フォールバック機能により、ユーザーは手動でモードを切り替える必要がなくなります。

### なぜAuto Mode OFFと完全なOFFモードを区別するのか

Auto Mode OFFは「プロキシが一時的に利用できない状態」であり、プロキシが再び利用可能になれば自動的に有効化されるべきです。一方、完全なOFFモードは「ユーザーがプロキシ機能を完全に無効化した状態」であり、自動的に有効化されるべきではありません。

### なぜ優先順位をシステムプロキシ → Manualプロキシとするのか

システムプロキシは、現在のネットワーク環境に最適化されている可能性が高いため、優先すべきです。Manualプロキシはフォールバックとして使用します。

### なぜフォールバック機能を無効化できるようにするのか

一部のユーザーは、Manualプロキシをフォールバックとして使用したくない場合があります（例：特定のネットワーク環境でのみ使用したい）。設定で無効化できるようにすることで、柔軟性を提供します。

## Future Enhancements

1. **複数のフォールバックプロキシ**: Manualプロキシだけでなく、複数のフォールバックプロキシを設定可能にする
2. **プロキシの自動学習**: 過去に成功したプロキシURLを記憶し、フォールバック候補として使用
3. **ネットワーク環境の検出**: Wi-Fi SSIDやネットワークアドレスに基づいて、最適なプロキシを自動選択
4. **プロキシのヘルスチェック**: 定期的にプロキシの応答時間を測定し、最速のプロキシを選択
