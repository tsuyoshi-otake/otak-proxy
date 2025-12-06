# Implementation Plan

- [x] 1. I18nManagerとlocaleファイルの作成





  - I18nManagerクラスを実装し、言語検出と翻訳ファイルの読み込み機能を提供
  - 英語と日本語の翻訳ファイルを作成
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 2.4, 2.5_

- [x] 1.1 I18nManagerクラスの実装


  - src/i18n/I18nManager.tsを作成
  - シングルトンパターンで実装
  - initialize()メソッドでvscode.env.languageから言語を検出
  - t()メソッドでメッセージキーから翻訳を取得
  - パラメータ置換機能を実装（{key}形式のプレースホルダー）
  - 欠落翻訳のフォールバック機能を実装
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 2.4_

- [x] 1.2 型定義ファイルの作成


  - src/i18n/types.tsを作成
  - SupportedLocale、TranslationMessages、I18nConfig型を定義
  - _Requirements: 2.5_

- [x] 1.3 英語翻訳ファイルの作成


  - src/i18n/locales/en.jsonを作成
  - すべてのメッセージキーと英語翻訳を定義
  - コマンド、アクション、メッセージ、警告、エラー、設定、ステータスバー、プロンプトのカテゴリに分類
  - _Requirements: 1.3, 2.1, 2.5_

- [x] 1.4 日本語翻訳ファイルの作成


  - src/i18n/locales/ja.jsonを作成
  - en.jsonと同じキーセットで日本語翻訳を定義
  - 技術用語（Proxy、Off、Manual、Autoなど）はそのまま残す
  - _Requirements: 1.2, 2.1, 2.5_

- [x] 1.5 I18nManagerのプロパティテストを作成


  - **Property 1: 非対応言語のフォールバック**
  - **Validates: Requirements 1.4**

- [x] 1.6 I18nManagerのプロパティテストを作成


  - **Property 3: パラメータ置換**
  - **Validates: Requirements 2.3**

- [x] 1.7 I18nManagerのプロパティテストを作成


  - **Property 4: 欠落翻訳のフォールバック**
  - **Validates: Requirements 2.4**



- [x] 2. UserNotifierクラスの多言語化対応




  - UserNotifierクラスを修正してI18nManagerを使用
  - メッセージキーベースのメソッドを追加
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 2.1 UserNotifierクラスの修正


  - I18nManagerのインスタンスを取得
  - showError()、showSuccess()、showWarning()メソッドを修正
  - メッセージキーとパラメータを受け取るオーバーロードを追加
  - 既存のメソッドは後方互換性のために残す
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 2.2 UserNotifierのユニットテストを作成


  - 各メッセージタイプ（情報、警告、エラー、成功）が正しい言語で表示されることを確認
  - _Requirements: 3.1, 3.2, 3.3, 3.4_


- [x] 3. extension.tsの主要メッセージの多言語化



  - extension.tsの主要なユーザー向けメッセージをI18nManagerを使用するように修正
  - アクションボタンのラベルを多言語化
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3.1 拡張機能の初期化時にI18nManagerを初期化


  - activate()関数の最初でI18nManager.getInstance().initialize()を呼び出す
  - _Requirements: 1.1, 1.5_

- [x] 3.2 初期セットアップダイアログの多言語化


  - askForInitialSetup()関数のメッセージとボタンラベルを多言語化
  - "How would you like to configure proxy settings?" → メッセージキーを使用
  - "Auto (System)"、"Manual Setup"、"Skip" → メッセージキーを使用
  - _Requirements: 3.1, 3.5_

- [x] 3.3 toggleProxyコマンドのメッセージ多言語化


  - "No manual proxy configured. Set one up now?" → メッセージキーを使用
  - "Yes"、"Skip to Auto" → メッセージキーを使用
  - "No system proxy detected. Switching to Off mode." → メッセージキーを使用
  - _Requirements: 3.1, 3.2, 3.5_


- [x] 3.4 testProxyコマンドのメッセージ多言語化



  - "No proxy configured. Current mode: {mode}" → メッセージキーを使用
  - "Configure Manual"、"Import System"、"Cancel" → メッセージキーを使用
  - "Testing {mode} proxy: {url}..." → メッセージキーを使用
  - "{mode} proxy works: {url}" → メッセージキーを使用
  - エラーメッセージと提案を多言語化
  - _Requirements: 3.1, 3.3, 3.5_

- [x] 3.5 importProxyコマンドのメッセージ多言語化


  - "Detecting system proxy..." → メッセージキーを使用
  - "Found system proxy: {url}" → メッセージキーを使用
  - "Use Auto Mode"、"Test First"、"Save as Manual"、"Cancel" → メッセージキーを使用
  - "Proxy works! How would you like to use it?" → メッセージキーを使用
  - "Switched to Auto mode: {url}" → メッセージキーを使用
  - "Saved as manual proxy: {url}" → メッセージキーを使用
  - エラーメッセージを多言語化
  - _Requirements: 3.1, 3.4, 3.5_

- [x] 3.6 その他のメッセージの多言語化


  - "System proxy changed: {url}" → メッセージキーを使用
  - "System proxy removed" → メッセージキーを使用
  - "Proxy disabled" → メッセージキーを使用
  - "Proxy configured: {url}" → メッセージキーを使用
  - "Unable to persist proxy settings..." → メッセージキーを使用
  - _Requirements: 3.1, 3.2, 3.4_


- [x] 4. ステータスバーの多言語化




  - updateStatusBar()関数を修正してステータスバーのテキストとツールチップを多言語化
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 4.1 ステータスバーテキストの多言語化


  - "Auto: {url}"、"Auto: No system proxy" → メッセージキーを使用
  - "Manual: {url}"、"Manual: Not configured" → メッセージキーを使用
  - "Proxy: Off" → メッセージキーを使用（技術用語なのでそのまま）
  - _Requirements: 4.2, 4.3, 4.4_


- [x] 4.2 ステータスバーツールチップの多言語化


  - "Proxy Configuration"、"Current Mode"、"Status" → メッセージキーを使用
  - "Last Check"、"Detection Source"、"Last Error" → メッセージキーを使用
  - "Consecutive Failures"、"Manual Proxy"、"System Proxy" → メッセージキーを使用
  - コマンドリンクのラベル（"Toggle Mode"、"Configure Manual"、"Import System"、"Test Proxy"）を多言語化
  - _Requirements: 4.5_

- [x] 4.3 ステータスバーのユニットテストを作成


  - ステータスバーのテキストとツールチップが正しい言語で表示されることを確認
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 5. package.jsonとpackage.nls.jsonファイルの作成




  - package.jsonのコマンドタイトルと設定説明を多言語化
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 5.1 package.nls.jsonファイルの作成


  - ルートディレクトリにpackage.nls.jsonを作成
  - コマンドタイトルと設定説明の英語翻訳を定義
  - _Requirements: 5.2, 5.3, 5.4, 6.2, 6.3, 6.4, 6.5_

- [x] 5.2 package.nls.ja.jsonファイルの作成


  - ルートディレクトリにpackage.nls.ja.jsonを作成
  - コマンドタイトルと設定説明の日本語翻訳を定義
  - _Requirements: 5.2, 5.3, 5.4, 6.2, 6.3, 6.4, 6.5_

- [x] 5.3 package.jsonの修正


  - コマンドタイトルを%key%形式に変更
  - 設定説明を%key%形式に変更
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5_


- [x] 6. エラーハンドリングとログ機能の実装




  - 欠落翻訳の警告ログを実装
  - JSONパースエラーのハンドリングを実装
  - _Requirements: 7.1, 7.2, 7.3_


- [x] 6.1 欠落翻訳の警告ログを実装


  - I18nManager.t()メソッドで翻訳が見つからない場合に警告をログに記録
  - Logger.warn()を使用
  - _Requirements: 7.1_

- [x] 6.2 JSONパースエラーのハンドリングを実装


  - I18nManager.initialize()メソッドでJSONパースエラーをキャッチ
  - エラーをログに記録し、フォールバック言語を使用
  - _Requirements: 7.3_

- [x] 6.3 翻訳ファイル検証のユニットテストを作成


  - すべての言語ファイルで同じキーセットが存在することを確認
  - _Requirements: 7.2_

- [x] 6.4 エラーハンドリングのユニットテストを作成


  - JSONパースエラーが正しく処理されることを確認
  - 欠落翻訳が正しくフォールバックされることを確認
  - _Requirements: 7.1, 7.3_


- [x] 7. 統合テストとドキュメント更新




  - 実際の拡張機能の動作を確認
  - READMEに多言語化機能を追加


- [x] 7.1 統合テストを作成

  - 言語を切り替えてコマンドパレットのタイトルが変わることを確認
  - 各種メッセージが正しい言語で表示されることを確認
  - ステータスバーが正しい言語で表示されることを確認
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4_

- [x] 7.2 READMEの更新



  - 多言語化機能について説明を追加
  - 対応言語（英語、日本語）を記載
  - 言語の自動検出について説明
  - _Requirements: 1.5_


- [x] 8. Checkpoint - すべてのテストが通ることを確認




  - すべてのテストが通ることを確認し、問題があればユーザーに質問する
