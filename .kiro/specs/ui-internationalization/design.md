# Design Document

## Overview

この設計では、otak-proxy拡張機能のUIを日本語と英語に対応させます。ただし、過剰なローカライズは避け、技術用語（"Proxy"、"Manual"、 "Off"、"Auto"など）はそのまま残します。ユーザーが理解しづらい説明文やアクションボタンのラベル（"Configure Manual"、"Import System"など）を中心に翻訳します。

VS Codeの`vscode.env.language`を使用して現在の表示言語を検出し、対応する言語ファイルから翻訳を読み込みます。対応していない言語の場合は英語にフォールバックします。

### 翻訳対象の方針

**翻訳する:**
- ユーザー向けメッセージ（情報、警告、エラー）
- アクションボタンのラベル（"Configure Manual" → "手動設定"）
- 説明文やヘルプテキスト
- 設定項目の説明（package.jsonのdescription）

**翻訳しない:**
- 技術用語: "Proxy", "Off", "Manual", "Auto", "Git", "VSCode", "npm"
- モード名: "Off", "Manual", "Auto"
- URL、ホスト名、ポート番号などの技術的な値
- コマンドID（内部的な識別子）

## Architecture

### Component Structure

```
src/
├── i18n/
│   ├── I18nManager.ts          # 多言語化マネージャー（シングルトン）
│   ├── locales/
│   │   ├── en.json             # 英語翻訳
│   │   └── ja.json             # 日本語翻訳
│   └── types.ts                # 型定義
├── errors/
│   └── UserNotifier.ts         # 修正: I18nManagerを使用
└── extension.ts                # 修正: I18nManagerを使用
```


### Language Detection Flow

```
起動時
  ↓
vscode.env.languageから言語コードを取得
  ↓
対応言語か判定（ja, en）
  ↓
├─ 対応している → その言語のJSONファイルを読み込み
└─ 対応していない → 英語（デフォルト）を読み込み
  ↓
I18nManagerに翻訳データを格納
  ↓
アプリケーション全体で使用可能
```

## Components and Interfaces

### I18nManager

多言語化を管理するシングルトンクラス。言語検出、翻訳ファイルの読み込み、メッセージの取得を担当します。

```typescript
class I18nManager {
  private static instance: I18nManager;
  private currentLocale: string;
  private messages: Record<string, string>;
  
  static getInstance(): I18nManager;
  initialize(locale?: string): void;
  t(key: string, params?: Record<string, string>): string;
  getCurrentLocale(): string;
}
```

**主要メソッド:**

- `getInstance()`: シングルトンインスタンスを取得
- `initialize(locale?)`: 言語を検出し、翻訳ファイルを読み込む。localeが指定されていない場合は`vscode.env.language`から自動検出
- `t(key, params?)`: メッセージキーから翻訳を取得。paramsでプレースホルダーを置換
- `getCurrentLocale()`: 現在の言語コードを返す

### Translation Message Format

翻訳ファイルはフラットなJSON構造で、キーと翻訳文字列のペアを格納します。


**例: en.json**
```json
{
  "command.toggleProxy": "Toggle Proxy",
  "command.testProxy": "Test Proxy",
  "command.importProxy": "Import System Proxy",
  "action.configureManual": "Configure Manual",
  "action.importSystem": "Import System",
  "action.testFirst": "Test First",
  "action.useAutoMode": "Use Auto Mode",
  "action.saveAsManual": "Save as Manual",
  "message.noProxyConfigured": "No proxy configured. Current mode: {mode}",
  "message.proxyWorks": "{mode} proxy works: {url}",
  "message.systemProxyChanged": "System proxy changed: {url}",
  "message.systemProxyRemoved": "System proxy removed"
}
```

**例: ja.json**
```json
{
  "command.toggleProxy": "Proxyを切り替え",
  "command.testProxy": "Proxyをテスト",
  "command.importProxy": "システムProxyをインポート",
  "action.configureManual": "手動設定",
  "action.importSystem": "システムからインポート",
  "action.testFirst": "先にテスト",
  "action.useAutoMode": "Autoモードを使用",
  "action.saveAsManual": "Manualとして保存",
  "message.noProxyConfigured": "Proxyが設定されていません。現在のモード: {mode}",
  "message.proxyWorks": "{mode} proxyは動作しています: {url}",
  "message.systemProxyChanged": "システムproxyが変更されました: {url}",
  "message.systemProxyRemoved": "システムproxyが削除されました"
}
```

### Parameter Substitution

動的な値（プロキシURL、モード名など）を含むメッセージは、プレースホルダー `{paramName}` を使用します。

```typescript
// 使用例
i18n.t('message.proxyWorks', { mode: 'Manual', url: 'http://proxy:8080' })
// 英語: "Manual proxy works: http://proxy:8080"
// 日本語: "Manual proxyは動作しています: ht

## Data Models

### Locale Type

```typescript
type SupportedLocale = 'en' | 'ja';

interface TranslationMessages {
  [key: string]: string;
}

interface I18nConfig {
  defaultLocale: SupportedLocale;
  supportedLocales: SupportedLocale[];
  fallbackLocale: SupportedLocale;
}
```

### Message Key Naming Convention

メッセージキーは以下の命名規則に従います：

- `command.*`: コマンドタイトル（コマンドパレット用）
- `action.*`: アクションボタンのラベル
- `message.*`: ユーザー向けメッセージ（情報、成功）
- `warning.*`: 警告メッセージ
- `error.*`: エラーメッセージ
- `config.*`: 設定項目の説明
- `statusbar.*`: ステータスバー関連のテキスト
- `prompt.*`: 入力プロンプトのテキスト

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. 
Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Acceptance Criteria Testing Prework

1.1 WHEN the Extension starts THEN the Extension SHALL detect the Display Language from VS Code's environment
  Thoughts: これは起動時に一度だけ実行される処理で、vscode.env.languageの値を読み取るだけです。特定の入力に対する振る舞いではなく、環境変数の読み取りなので、プロパティテストには適していません。
  Testable: yes - example

1.2 WHEN the Display Language is Japanese ("ja") THEN the Extension SHALL load and display all UI messages in Japanese
  Thoughts: これは特定の言語コード（"ja"）に対する振る舞いです。日本語の翻訳ファイルが正しく読み込まれ、メッセージが日本語で返されることを確認する必要があります。
  Testable: yes - example


1.3 WHEN the Display Language is English ("en") THEN the Extension SHALL load and display all UI messages in English
  Thoughts: これも特定の言語コード（"en"）に対する振る舞いです。英語の翻訳ファイルが正しく読み込まれることを確認します。
  Testable: yes - example

1.4 WHEN the Display Language is neither Japanese nor English THEN the Extension SHALL load and display all UI messages in the Fallback Language (English)
  Thoughts: これは対応していない言語コード（例: "fr", "de", "zh-cn"など）に対する振る舞いです。任意の非対応言語コードに対して英語にフォールバックすることを確認する必要があります。
  Testable: yes - property

1.5 WHERE a Language Pack is installed THEN the Extension SHALL automatically use the corresponding language without requiring manual configuration
  Thoughts: これはLanguage Packがインストールされている環境での振る舞いですが、実際にはvscode.env.languageの値が変わるだけなので、1.1-1.4でカバーされます。
  Testable: no

2.1 WHEN a developer adds a new UI message THEN the Extension SHALL provide a centralized location for defining message keys and translations
  Thoughts: これは開発プロセスに関する要件で、コードの構造に関するものです。実行時の振る舞いではありません。
  Testable: no

2.2 WHEN a message key is defined THEN the Extension SHALL require translations for all supported languages (Japanese and English)
  Thoughts: これは開発時の制約で、実行時の振る舞いではありません。ただし、翻訳ファイルの完全性をチェックする検証ツールを作成することは可能です。
  Testable: no

2.3 WHEN a message contains dynamic content (e.g., proxy URLs, mode names) THEN the Extension SHALL support parameter substitution in translated messages
  Thoughts: これはパラメータ置換機能のテストです。任意のメッセージキーとパラメータに対して、正しく置換されることを確認する必要があります。
  Testable: yes - property


2.4 WHEN a translation is missing for a specific language THEN the Extension SHALL fall back to the Fallback Language translation for that message key
  Thoughts: これは任意のメッセージキーに対して、翻訳が欠落している場合の振る舞いです。フォールバック機能が正しく動作することを確認する必要があります。
  Testable: yes - property

2.5 THE Extension SHALL organize Message Bundles by language code (e.g., "ja.json", "en.json")
  Thoughts: これはファイル構造に関する要件で、実行時の振る舞いではありません。
  Testable: no

3.1 WHEN the Extension displays an information message THEN the Extension SHALL show the message in the user's detected language
  Thoughts: これは情報メッセージの表示に関する振る舞いです。任意のメッセージキーに対して、正しい言語で表示されることを確認します。
  Testable: yes - property

3.2 WHEN the Extension displays a warning message THEN the Extension SHALL show the message in the user's detected language
  Thoughts: 3.1と同様に、警告メッセージの表示に関する振る舞いです。
  Testable: yes - property

3.3 WHEN the Extension displays an error message THEN the Extension SHALL show the message in the user's detected language
  Thoughts: 3.1と同様に、エラーメッセージの表示に関する振る舞いです。
  Testable: yes - property

3.4 WHEN the Extension displays a success message THEN the Extension SHALL show the message in the user's detected language
  Thoughts: 3.1と同様に、成功メッセージの表示に関する振る舞いです。
  Testable: yes - property

3.5 WHEN the Extension displays action button labels THEN the Extension SHALL show the labels in the user's detected language
  Thoughts: 3.1と同様に、アクションボタンのラベル表示に関する振る舞いです。
  Testable: yes - property


4.1-4.5, 5.1-5.5, 6.1-6.5 (ステータスバー、コマンド、設定の多言語化)
  Thoughts: これらはすべて、特定のUIコンポーネントに対する翻訳の適用です。基本的には3.1-3.5と同じパターンで、メッセージキーから翻訳を取得して表示する振る舞いです。
  Testable: yes - property (統合的にテスト可能)

7.1 WHEN a message key is used in the code THEN the Extension SHALL log a warning if the translation is missing for any supported language
  Thoughts: これは欠落している翻訳を検出する機能です。任意のメッセージキーに対して、翻訳が欠落している場合に警告がログに記録されることを確認します。
  Testable: yes - property

7.2 WHEN the Extension loads Message Bundles THEN the Extension SHALL validate that all message keys exist in all language files
  Thoughts: これは翻訳ファイルの読み込み時の検証です。すべての言語ファイルで同じキーセットが存在することを確認します。
  Testable: yes - example

7.3 WHEN a translation file has a syntax error THEN the Extension SHALL log an error and fall back to the Fallback Language
  Thoughts: これはJSONパースエラーのハンドリングです。不正なJSONファイルに対してエラーログを出力し、フォールバックすることを確認します。
  Testable: yes - example

7.4 THE Extension SHALL provide a mechanism to list all message keys used in the codebase
  Thoughts: これは開発ツールに関する要件で、実行時の振る舞いではありません。
  Testable: no

7.5 THE Extension SHALL provide a mechanism to identify untranslated message keys
  Thoughts: これも開発ツールに関する要件で、実行時の振る舞いではありません。
  Testable: no


### Property Reflection

プロパティの冗長性を確認します：

- **3.1-3.5 (メッセージ表示)**: これらは全て「メッセージキーから翻訳を取得して表示する」という同じ振る舞いです。メッセージの種類（情報、警告、エラー、成功、アクション）によって分かれていますが、内部的には同じI18nManager.t()メソッドを使用します。これらは**Property 2**として統合できます。

- **4.1-4.5, 5.1-5.5, 6.1-6.5**: これらもメッセージキーから翻訳を取得する振る舞いで、**Property 2**に含まれます。

統合後のプロパティ：

1. **Property 1**: 言語検出とフォールバック（1.4をカバー）
2. **Property 2**: メッセージ翻訳の取得（3.1-3.5, 4.1-4.5, 5.1-5.5, 6.1-6.5をカバー）
3. **Property 3**: パラメータ置換（2.3をカバー）
4. **Property 4**: 欠落翻訳のフォールバック（2.4をカバー）
5. **Property 5**: 欠落翻訳の警告ログ（7.1をカバー）

例（Example）としてテストするもの：
- 日本語の読み込み（1.2）
- 英語の読み込み（1.3）
- 翻訳ファイルの検証（7.2）
- JSONパースエラーのハンドリング（7.3）

### Correctness Properties

Property 1: 非対応言語のフォールバック
*For any* 非対応の言語コード（"ja"と"en"以外）、I18nManagerを初期化すると、英語（フォールバック言語）が使用される
**Validates: Requirements 1.4**

Property 2: メッセージ翻訳の取得
*For any* 有効なメッセージキーと言語設定、I18nManager.t()を呼び出すと、その言語に対応する翻訳文字列が返される
**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.2, 5.3, 5.4, 6.2, 6.3, 6.4, 6.5**


Property 3: パラメータ置換
*For any* メッセージキーとパラメータのセット、I18nManager.t()を呼び出すと、翻訳文字列内のプレースホルダー（{key}）が対応するパラメータ値で置換される
**Validates: Requirements 2.3**

Property 4: 欠落翻訳のフォールバック
*For any* メッセージキーが現在の言語で存在しない場合、I18nManager.t()を呼び出すと、フォールバック言語（英語）の翻訳が返される
**Validates: Requirements 2.4**

Property 5: 欠落翻訳の警告ログ
*For any* メッセージキーが現在の言語で存在しない場合、I18nManager.t()を呼び出すと、警告がログに記録される
**Validates: Requirements 7.1**

## Error Handling

### Missing Translation Keys

メッセージキーが見つからない場合：
1. 警告をログに記録
2. フォールバック言語（英語）の翻訳を試行
3. それでも見つからない場合は、メッセージキー自体を返す（例: `[missing: message.example]`）

### JSON Parse Errors

翻訳ファイルのパースに失敗した場合：
1. エラーをログに記録
2. フォールバック言語（英語）を使用
3. 拡張機能の起動は継続（エラーで停止しない）

### Invalid Locale

無効な言語コードが指定された場合：
1. 警告をログに記録
2. フォールバック言語（英語）を使用


## Testing Strategy

### Unit Tests

以下の具体的なケースをユニットテストでカバーします：

1. **言語検出**
   - 日本語（"ja"）の検出と読み込み
   - 英語（"en"）の検出と読み込み
   - 起動時の言語検出（vscode.env.languageの読み取り）

2. **翻訳ファイルの検証**
   - すべての言語ファイルで同じキーセットが存在することを確認
   - JSONパースエラーのハンドリング

3. **エラーハンドリング**
   - 欠落しているメッセージキーの処理
   - 不正なJSONファイルの処理

### Property-Based Tests

fast-checkライブラリを使用して、以下のプロパティを検証します。各テストは最低100回の反復を実行します。

1. **Property 1: 非対応言語のフォールバック**
   - 任意の非対応言語コード（"ja"と"en"以外）を生成
   - I18nManagerを初期化
   - 英語が使用されることを確認

2. **Property 2: メッセージ翻訳の取得**
   - 任意の有効なメッセージキーを生成
   - 任意の対応言語（"ja"または"en"）を生成
   - I18nManager.t()を呼び出し
   - 対応する翻訳が返されることを確認

3. **Property 3: パラメータ置換**
   - 任意のメッセージキーとパラメータセットを生成
   - I18nManager.t()を呼び出し
   - すべてのプレースホルダーが置換されることを確認

4. **Property 4: 欠落翻訳のフォールバック**
   - 任意の存在しないメッセージキーを生成
   - I18nManager.t()を呼び出し
   - フォールバック言語の翻訳またはキー自体が返されることを確認

5. **Property 5: 欠落翻訳の警告ログ**
   - 任意の存在しないメッセージキーを生成
   - I18nManager.t()を呼び出し
   - 警告がログに記録されることを確認


### Integration Tests

実際の拡張機能の動作を確認するための統合テスト：

1. **コマンドタイトルの多言語化**
   - 言語を切り替えてコマンドパレットのタイトルが変わることを確認

2. **メッセージ表示の多言語化**
   - 各種メッセージ（情報、警告、エラー）が正しい言語で表示されることを確認

3. **ステータスバーの多言語化**
   - ステータスバーのテキストとツールチップが正しい言語で表示されることを確認

## Implementation Notes

### Package.json Localization

VS Codeは`package.nls.json`ファイルを使用してpackage.jsonの文字列を多言語化します。

**package.nls.json (デフォルト/英語):**
```json
{
  "command.toggleProxy": "Toggle Proxy",
  "command.testProxy": "Test Proxy",
  "command.importProxy": "Import System Proxy",
  "config.proxyUrl": "Proxy server URL (e.g., http://proxy.example.com:8080) for VSCode and Git proxy settings",
  "config.pollingInterval": "Auto mode polling interval in seconds (10-300). How often to check for system proxy changes.",
  "config.detectionSourcePriority": "Priority order for proxy detection sources. Sources are tried in order until one succeeds.",
  "config.maxRetries": "Maximum number of retries for proxy detection when it fails."
}
```

**package.nls.ja.json (日本語):**
```json
{
  "command.toggleProxy": "Proxyを切り替え",
  "command.testProxy": "Proxyをテスト",
  "command.importProxy": "システムProxyをインポート",
  "config.proxyUrl": "VSCodeとGitのproxy設定用のProxyサーバーURL（例: http://proxy.example.com:8080）",
  "config.pollingInterval": "Autoモードのポーリング間隔（秒単位、10-300）。システムproxyの変更をチェックする頻度。",
  "config.detectionSourcePriority": "Proxy検出ソースの優先順位。指定された順序で試行され、最初に成功したものが使用されます。",
  "config.maxRetries": "Proxy検出が失敗した場合の最大リトライ回数。"
}
```


package.jsonでは、文字列を`%key%`形式で参照します：

```json
{
  "contributes": {
    "commands": [
      {
        "command": "otak-proxy.toggleProxy",
        "title": "%command.toggleProxy%"
      }
    ],
    "configuration": {
      "properties": {
        "otakProxy.proxyUrl": {
          "description": "%config.proxyUrl%"
        }
      }
    }
  }
}
```

### Migration Strategy

既存のコードを段階的に移行します：

1. **Phase 1**: I18nManagerとlocaleファイルを作成
2. **Phase 2**: UserNotifierクラスを修正してI18nManagerを使用
3. **Phase 3**: extension.tsの主要なメッセージを移行
4. **Phase 4**: package.jsonとpackage.nls.jsonファイルを作成
5. **Phase 5**: 残りのメッセージを移行

### Performance Considerations

- 翻訳ファイルは起動時に一度だけ読み込み、メモリにキャッシュ
- メッセージの取得は同期的に実行（ファイルI/Oなし）
- パラメータ置換は単純な文字列置換で実装（正規表現を使用）

### Backward Compatibility

- 既存のハードコードされたメッセージは段階的に移行
- 移行中は英語のメッセージが表示される（既存の動作を維持）
- 翻訳ファイルが見つからない場合でも拡張機能は正常に動作

## Future Enhancements

将来的に追加可能な機能：

1. **追加言語のサポート**: 中国語、韓国語、フランス語など
2. **動的言語切り替え**: 拡張機能の再起動なしで言語を変更
3. **翻訳の外部化**: 翻訳をクラウドサービスから取得
4. **翻訳の貢献**: コミュニティによる翻訳の追加をサポート
