# otak-proxy アーキテクチャドキュメント

## 概要

このドキュメントは、otak-proxy拡張機能のアーキテクチャと設計判断について詳細に説明します。

## リファクタリングの背景

### 問題点（リファクタリング前）

- **単一ファイルの肥大化**: extension.tsが1335行に達し、保守が困難
- **責任の混在**: コマンド、状態管理、UI更新、設定適用が同一ファイルに混在
- **コードの重複**: 特にimportProxyコマンド内で同様のロジックが3回繰り返される
- **テストの遅さ**: 外部コマンド依存が多く、プロパティベーステストの実行回数が高い

### 改善結果（リファクタリング後）

- **ファイルサイズ**: extension.ts 1335行 → 160行（88%削減）
- **モジュール数**: 30+の焦点を絞ったモジュール
- **テストカバレッジ**: 389個のテスト（ユニット + プロパティベース）
- **ファイルサイズ制限**: すべてのファイルが300行以下
- **循環依存**: なし（madgeで検証済み）

## フォルダ構造

```
src/
├── extension.ts          # エントリーポイント（160行）
│
├── core/                 # コアビジネスロジック
│   ├── types.ts         # 共通型定義
│   ├── ProxyStateManager.ts    # 状態永続化
│   ├── ProxyApplier.ts         # プロキシ設定オーケストレーション
│   └── ExtensionInitializer.ts # 初期化ロジック
│
├── commands/            # コマンド実装
│   ├── types.ts         # コマンド固有の型
│   ├── CommandRegistry.ts      # コマンド登録の一元管理
│   ├── ToggleProxyCommand.ts   # モード切り替え
│   ├── ConfigureUrlCommand.ts  # 手動プロキシURL設定
│   ├── TestProxyCommand.ts     # プロキシ接続テスト
│   ├── ImportProxyCommand.ts   # システムプロキシ検出とインポート
│   └── index.ts         # モジュールエクスポート
│
├── ui/                  # ユーザーインターフェース
│   └── StatusBarManager.ts     # ステータスバー管理
│
├── config/              # 設定マネージャー
│   ├── GitConfigManager.ts     # Git設定
│   ├── VscodeConfigManager.ts  # VSCode設定
│   ├── NpmConfigManager.ts     # npm設定
│   └── SystemProxyDetector.ts  # システムプロキシ検出
│
├── monitoring/          # プロキシ監視（Autoモード）
│   ├── ProxyMonitor.ts         # ポーリングベースの変更検出
│   ├── ProxyMonitorState.ts    # モニター状態管理
│   └── ProxyChangeLogger.ts    # 変更イベントログ
│
├── validation/          # 入力検証とセキュリティ
│   ├── ProxyUrlValidator.ts    # URL検証
│   └── InputSanitizer.ts       # コマンドインジェクション防止
│
├── errors/              # エラーハンドリング
│   ├── ErrorAggregator.ts      # 複数ソースからのエラー収集
│   └── UserNotifier.ts         # ユーザー向けエラー通知
│
├── i18n/                # 国際化
│   ├── types.ts         # i18n型定義
│   ├── I18nManager.ts          # 翻訳マネージャー（シングルトン）
│   └── locales/                # 翻訳ファイル
│       ├── en.json
│       └── ja.json
│
├── models/              # データモデル
│   └── ProxyUrl.ts             # プロキシURL解析と検証
│
├── utils/               # 共有ユーティリティ
│   ├── Logger.ts               # 集中ログ管理
│   └── ProxyUtils.ts           # プロキシ関連ユーティリティ
│
└── test/                # テストスイート
    ├── *.test.ts               # ユニットテスト
    ├── *.property.test.ts      # プロパティベーステスト
    ├── generators.ts           # テストデータジェネレーター
    └── helpers.ts              # テストユーティリティ
```

## 設計原則

### 1. 単一責任の原則（Single Responsibility Principle）

各モジュールは1つの明確な責任を持ちます：

- **ProxyStateManager**: 状態の永続化のみを担当
- **ProxyApplier**: プロキシ設定の適用のみを担当
- **StatusBarManager**: UI更新のみを担当
- **各Command**: 1つのコマンドの実行のみを担当

### 2. 依存性注入（Dependency Injection）

コンポーネントはコンストラクタを通じて依存関係を受け取ります：

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
}
```

**利点**:
- テスト時にモックを簡単に注入できる
- 依存関係グラフが明確
- 隠れたグローバル状態がない

### 3. エラー集約（Error Aggregation）

複数の設定エラーを収集して一度に表示：

```typescript
const errorAggregator = new ErrorAggregator();

// Git、VSCode、npmの設定を試行
await this.updateManager(this.gitManager, 'Git', enabled, proxyUrl, errorAggregator);
await this.updateManager(this.vscodeManager, 'VSCode', enabled, proxyUrl, errorAggregator);
await this.updateManager(this.npmManager, 'npm', enabled, proxyUrl, errorAggregator);

// すべてのエラーを一度に表示
if (errorAggregator.hasErrors()) {
    this.userNotifier.showAggregatedErrors(errorAggregator);
}
```

**利点**:
- ユーザーはすべての問題を一度に確認できる
- 1つずつエラーを修正する必要がない

### 4. 状態管理の集中化

ProxyStateManagerがすべての状態操作を管理：

```typescript
export class ProxyStateManager {
    private inMemoryState: ProxyState | null = null;
    
    async getState(): Promise<ProxyState> {
        // globalStateから読み込み、失敗時はin-memoryフォールバック
    }
    
    async saveState(state: ProxyState): Promise<void> {
        // globalStateに保存、失敗時はin-memoryフォールバック
    }
}
```

**利点**:
- 状態の読み書きが一貫性を持つ
- 自動フォールバック機能
- 古い設定からの透過的な移行

### 5. コマンドパターン

各コマンドは純粋関数としてCommandContextを受け取ります：

```typescript
export async function executeToggleProxy(ctx: CommandContext): Promise<void> {
    const currentState = await ctx.stateManager.getState();
    // コマンドロジック
}
```

**利点**:
- 既存のコードを変更せずに新しいコマンドを追加できる
- テストが容易
- コマンド間の独立性が保証される

### 6. プロパティベーステスト

fast-checkを使用してコアロジックを検証：

```typescript
it('Property 3: State persistence fallback', () => {
    fc.assert(
        fc.asyncProperty(
            fc.record({
                mode: fc.constantFrom('off', 'manual', 'auto'),
                manualProxyUrl: fc.option(fc.webUrl()),
                // ...
            }),
            async (state) => {
                // globalState.updateが失敗してもin-memoryフォールバックが機能することを検証
            }
        ),
        { numRuns: 100 }
    );
});
```

**利点**:
- ランダムな入力で境界ケースを発見
- ユニットテストを補完して包括的なカバレッジを実現

## コンポーネント間の相互作用

### 起動フロー

```
1. extension.ts activate()
   ↓
2. ExtensionInitializer.initialize()
   ├─→ 初回起動チェック
   ├─→ 状態の移行
   └─→ コンポーネントの初期化
   ↓
3. CommandRegistry.registerAll()
   ├─→ コマンド登録
   ├─→ 設定変更リスナー
   └─→ ウィンドウフォーカスリスナー
   ↓
4. StatusBarManager.update()
   └─→ 初期UI表示
```

### コマンド実行フロー（例: Toggle Proxy）

```
1. ユーザーがステータスバーをクリック
   ↓
2. ToggleProxyCommand.executeToggleProxy()
   ↓
3. ProxyStateManager.getState()
   └─→ 現在の状態を取得
   ↓
4. 次のモードを決定（Off → Manual → Auto）
   ↓
5. ProxyApplier.applyProxy() または disableProxy()
   ├─→ GitConfigManager
   ├─→ VscodeConfigManager
   └─→ NpmConfigManager
   ↓
6. ProxyStateManager.saveState()
   └─→ 新しい状態を保存
   ↓
7. StatusBarManager.update()
   └─→ UIを更新
   ↓
8. UserNotifier.showInfo()
   └─→ 成功通知
```

### Autoモード監視フロー

```
1. ProxyMonitor.start()
   ↓
2. 定期的にポーリング（デフォルト30秒）
   ↓
3. SystemProxyDetector.detectProxy()
   ├─→ 環境変数チェック
   ├─→ VSCode設定チェック
   └─→ プラットフォーム固有の検出
   ↓
4. プロキシ変更を検出
   ↓
5. ProxyChangeLogger.logChange()
   └─→ 変更をログ記録
   ↓
6. ProxyApplier.applyProxy()
   └─→ 新しいプロキシを適用
   ↓
7. StatusBarManager.update()
   └─→ UIを更新
```

## モジュール詳細

### Core Modules

#### extension.ts
- **責任**: エントリーポイント、コンポーネントのオーケストレーション
- **行数**: 160行
- **主要機能**:
  - `activate()`: 拡張機能の初期化
  - `deactivate()`: クリーンアップ
  - コンポーネントのインスタンス化

#### ExtensionInitializer
- **責任**: 初回起動処理、状態移行、コンポーネント初期化
- **主要機能**:
  - 初回起動の検出とセットアップダイアログ
  - 古い設定からの移行
  - Autoモード監視の開始

#### ProxyStateManager
- **責任**: ProxyStateの永続化と取得
- **主要機能**:
  - `getState()`: 状態の読み込み（自動フォールバック付き）
  - `saveState()`: 状態の保存（自動フォールバック付き）
  - `migrateOldSettings()`: 古い設定からの移行
- **テスト**: ProxyStateManager.test.ts, ProxyStateManager.property.test.ts

#### ProxyApplier
- **責任**: プロキシ設定の適用オーケストレーション
- **主要機能**:
  - `applyProxy()`: プロキシの有効化
  - `disableProxy()`: プロキシの無効化
  - エラー集約とユーザー通知
- **テスト**: ProxyApplier.test.ts, ProxyApplier.property.test.ts

### Command Modules

#### CommandRegistry
- **責任**: すべてのコマンドとイベントリスナーの登録
- **主要機能**:
  - `registerAll()`: すべてのコマンドを登録
  - 設定変更リスナー
  - ウィンドウフォーカスリスナー

#### ToggleProxyCommand
- **責任**: Off → Manual → Autoのモード切り替え
- **フロー**:
  1. 現在のモードを取得
  2. 次のモードを決定
  3. プロキシを適用または無効化
  4. 状態を保存
  5. UIを更新

#### ConfigureUrlCommand
- **責任**: 手動プロキシURLの設定
- **フロー**:
  1. ユーザーにURLを入力させる
  2. URLを検証
  3. Manualモードに切り替え
  4. プロキシを適用

#### TestProxyCommand
- **責任**: プロキシ接続のテスト
- **フロー**:
  1. 現在のプロキシURLを取得
  2. テスト接続を実行
  3. 結果をユーザーに通知

#### ImportProxyCommand
- **責任**: システムプロキシの検出とインポート
- **フロー**:
  1. システムプロキシを検出
  2. ユーザーにアクションを選択させる（Auto/Manual/Test）
  3. 選択に応じてプロキシを適用

**リファクタリングのポイント**: 以前は同様のロジックが3回繰り返されていましたが、`handleUserAction()`と`applyProxyMode()`に統合されました。

### Configuration Modules

#### GitConfigManager
- **責任**: `git config --global http.proxy`の管理
- **主要機能**:
  - `setProxy()`: Gitプロキシを設定
  - `unsetProxy()`: Gitプロキシを削除
  - `getProxy()`: 現在のGitプロキシを取得

#### VscodeConfigManager
- **責任**: VSCodeワークスペースプロキシ設定の管理
- **主要機能**:
  - `setProxy()`: VSCodeプロキシを設定
  - `unsetProxy()`: VSCodeプロキシを削除
  - `getProxy()`: 現在のVSCodeプロキシを取得

#### NpmConfigManager
- **責任**: npm proxy設定の管理
- **主要機能**:
  - `setProxy()`: npmプロキシを設定（http-proxy、https-proxy）
  - `unsetProxy()`: npmプロキシを削除
  - `getProxy()`: 現在のnpmプロキシを取得

#### SystemProxyDetector
- **責任**: マルチプラットフォームのシステムプロキシ検出
- **検出ソース**:
  - 環境変数（HTTP_PROXY、HTTPS_PROXY）
  - VSCodeの既存プロキシ設定
  - **Windows**: Internet Explorerレジストリ設定
  - **macOS**: システムネットワーク設定（Wi-Fi、Ethernetなど）
  - **Linux**: GNOMEプロキシ設定（gsettings）

### UI & Monitoring

#### StatusBarManager
- **責任**: ステータスバーの表示とツールチップの管理
- **主要機能**:
  - `update()`: ProxyStateに基づいてUIを更新
  - `updateText()`: ステータスバーテキストを生成
  - `updateTooltip()`: ツールチップを生成
  - i18n対応

#### ProxyMonitor
- **責任**: Autoモードでのプロキシ変更の監視
- **主要機能**:
  - `start()`: ポーリングを開始
  - `stop()`: ポーリングを停止
  - 設定可能なポーリング間隔（10-300秒）
  - 指数バックオフによる自動リトライ

#### ProxyChangeLogger
- **責任**: プロキシ変更イベントのログ記録
- **主要機能**:
  - 変更の詳細をログに記録
  - 検出ソースの追跡
  - デバッグ情報の提供

### Validation & Error Handling

#### ProxyUrlValidator
- **責任**: プロキシURLの形式とセキュリティ検証
- **検証項目**:
  - URL形式（http://またはhttps://）
  - ホスト名の妥当性
  - ポート番号の範囲
  - セキュリティリスク（コマンドインジェクション）

#### InputSanitizer
- **責任**: コマンドインジェクション攻撃の防止
- **主要機能**:
  - シェルメタキャラクタの検出
  - 危険な文字列のエスケープ
  - ログとUIでの認証情報のマスキング

#### ErrorAggregator
- **責任**: 複数ソースからのエラー収集
- **主要機能**:
  - `addError()`: エラーを追加
  - `hasErrors()`: エラーの有無を確認
  - `getErrors()`: すべてのエラーを取得

#### UserNotifier
- **責任**: ユーザー向けのエラー通知
- **主要機能**:
  - `showError()`: エラーメッセージを表示
  - `showInfo()`: 情報メッセージを表示
  - `showAggregatedErrors()`: 集約されたエラーを表示
  - i18n対応

### Internationalization

#### I18nManager
- **責任**: 翻訳管理（シングルトン）
- **主要機能**:
  - `t()`: キーから翻訳を取得
  - `getCurrentLocale()`: 現在のロケールを取得
  - VSCode言語パックからの自動検出
- **サポート言語**: 英語、日本語

## テスト戦略

### デュアルテストアプローチ

拡張機能は2つのテストアプローチを使用します：

#### 1. ユニットテスト

- **目的**: 特定の例とエッジケースを検証
- **テスト数**: 200+
- **特徴**:
  - 個別関数をテスト
  - 外部依存関係をモック（Git、npmコマンド）
  - 高速実行でフィードバックが早い

**例**:
```typescript
it('should toggle from off to manual', async () => {
    const state = { mode: ProxyMode.Off };
    const nextMode = stateManager.getNextMode(state.mode);
    expect(nextMode).toBe(ProxyMode.Manual);
});
```

#### 2. プロパティベーステスト

- **目的**: 普遍的なプロパティを検証
- **テスト数**: 15+
- **ライブラリ**: fast-check
- **特徴**:
  - ランダムな入力を生成してエッジケースを発見
  - 設計ドキュメントの正しさプロパティを検証

**例**:
```typescript
it('Property 3: State persistence fallback', () => {
    fc.assert(
        fc.asyncProperty(
            arbitraryProxyState,
            async (state) => {
                // globalState.updateが失敗してもin-memoryフォールバックが機能することを検証
                mockGlobalState.update.mockRejectedValue(new Error('Storage failed'));
                await stateManager.saveState(state);
                const retrieved = await stateManager.getState();
                expect(retrieved).toEqual(state);
            }
        ),
        { numRuns: 100 }
    );
});
```

**検証されるプロパティ**:
- Property 1: コマンドエラーハンドリングの一貫性
- Property 2: コマンドの独立性
- Property 3: 状態永続化のフォールバック
- Property 4: レガシー状態の移行
- Property 5: プロキシ有効化シーケンス
- Property 6: プロキシ無効化の完全性
- Property 7: エラー集約
- Property 8: ステータスバーの状態反映
- Property 9: コマンドリンクの検証
- Property 10: ステータスバーの国際化

#### 3. 統合テスト

- **目的**: エンドツーエンドのワークフローを検証
- **特徴**:
  - コンポーネント間の連携をテスト
  - 必要に応じて実際のGit/npmコマンドを使用

### テストパフォーマンス最適化

#### 環境変数による実行回数制御

```typescript
// src/test/helpers.ts
export function getTestIterations(): number {
    return process.env.CI ? 100 : 10;
}
```

- **開発モード**: 10回（高速フィードバック）
- **CIモード**: 100回（包括的検証）

#### 並列実行

`.vscode-test.mjs`で並列実行を有効化：

```javascript
{
    parallel: true,
    workers: 4
}
```

#### モックの活用

- 外部コマンド（git、npm）はデフォルトでモック
- 統合テストのみ実際のコマンドを使用

#### 結果

- **開発モード**: ~30秒
- **CIモード**: ~2分
- **テスト数**: 389個すべて合格

## セキュリティ考慮事項

### 1. コマンドインジェクション防止

InputSanitizerがすべての入力を検証：

```typescript
export class InputSanitizer {
    sanitize(input: string): string {
        // シェルメタキャラクタを検出
        const dangerousChars = /[;&|`$(){}[\]<>]/;
        if (dangerousChars.test(input)) {
            throw new Error('Invalid characters detected');
        }
        return input;
    }
}
```

### 2. 認証情報のマスキング

ログとUIで認証情報を自動的にマスキング：

```typescript
function maskCredentials(url: string): string {
    return url.replace(/:\/\/([^:]+):([^@]+)@/, '://***:***@');
}
```

### 3. URL検証

ProxyUrlValidatorが厳格な検証を実施：

- プロトコルの検証（http://またはhttps://のみ）
- ホスト名の妥当性チェック
- ポート番号の範囲チェック（1-65535）

## パフォーマンス考慮事項

### ファイルサイズ削減の効果

- **ビルド時間**: モジュール分割により並列コンパイルが可能
- **増分ビルド**: 変更されたモジュールのみ再コンパイル
- **メモリ使用量**: 必要なモジュールのみロード

### 起動時間

- **遅延ロード**: 必要になるまでモジュールをロードしない
- **軽量な初期化**: extension.tsは最小限の処理のみ実行

### Autoモード監視

- **設定可能なポーリング間隔**: デフォルト30秒、10-300秒で調整可能
- **指数バックオフ**: 検出失敗時に自動リトライ
- **効率的な検出**: 変更がない場合は早期リターン

## 今後の拡張性

### 新しいコマンドの追加

1. `commands/NewCommand.ts`を作成
2. `executeNewCommand(ctx: CommandContext)`を実装
3. `CommandRegistry.registerAll()`に登録を追加

### 新しい設定マネージャーの追加

1. `config/NewConfigManager.ts`を作成
2. `setProxy()`、`unsetProxy()`、`getProxy()`を実装
3. `ProxyApplier`のコンストラクタに追加

### 新しいプロパティテストの追加

1. 設計ドキュメントにプロパティを追加
2. `src/test/*.property.test.ts`にテストを実装
3. `generators.ts`に必要なジェネレーターを追加

## 参考資料

- [VSCode Extension API](https://code.visualstudio.com/api)
- [fast-check Documentation](https://fast-check.dev/)
- [Property-Based Testing](https://hypothesis.works/articles/what-is-property-based-testing/)
- [SOLID Principles](https://en.wikipedia.org/wiki/SOLID)

## 変更履歴

- **2024-12**: 初版作成（リファクタリング完了後）
