# Requirements Document

## Project Description (Input)
Windows環境ではちゃんと動く事を確認しています。Windows向けに対する影響は与えずに、LinuxとMacにも対応してほしい。環境検出って今って出来るんだっけ？

## Introduction
本ドキュメントは、otak-proxy拡張機能のクロスプラットフォーム対応に関する要件を定義します。現在Windows環境で正常に動作している機能を維持しつつ、LinuxおよびmacOS環境でも同等の機能を提供することを目標とします。環境検出機能については、既存の`process.platform`を使用した実装が存在することを確認しています。

## Requirements

### Requirement 1: OS環境検出
**Objective:** As a 開発者, I want 拡張機能が実行されているOSを正確に検出する機能, so that 各OSに適した処理を実行できる

#### Acceptance Criteria
1. When 拡張機能が起動した時, the SystemProxyDetector shall `process.platform`を使用して現在のOSを検出する
2. The SystemProxyDetector shall Windows (`win32`)、macOS (`darwin`)、Linux (`linux`) の3つのプラットフォームを識別できる
3. If サポートされていないプラットフォームが検出された場合, then the SystemProxyDetector shall 警告ログを出力してnullを返す
4. The SystemProxyDetector shall 検出したプラットフォーム情報を`DetectionSource`型として返却する

### Requirement 2: Windows機能の互換性維持
**Objective:** As a Windows環境のユーザー, I want 既存のWindows向け機能が変更されずに動作し続けること, so that 現在の作業環境に影響を与えない

#### Acceptance Criteria
1. The SystemProxyDetector shall Windowsレジストリからのプロキシ設定読み取り機能を維持する
2. When プラットフォームが`win32`の場合, the SystemProxyDetector shall `reg query`コマンドを使用してプロキシ設定を検出する
3. The SystemProxyDetector shall Windowsの「http=proxy:port;https=proxy:port」形式のプロキシ値を正しく解析できる
4. The GitConfigManager shall Windows環境での`git config`コマンド実行を正常に処理する
5. The NpmConfigManager shall Windows環境での`npm config`コマンド実行を正常に処理する
6. The TerminalEnvConfigManager shall Windows環境での統合ターミナル環境変数設定を正常に処理する

### Requirement 3: macOSプラットフォーム対応
**Objective:** As a macOS環境のユーザー, I want Windowsと同等のプロキシ管理機能を利用したい, so that macOSでも効率的にプロキシ設定を管理できる

#### Acceptance Criteria
1. When プラットフォームが`darwin`の場合, the SystemProxyDetector shall `networksetup`コマンドを使用してシステムプロキシを検出する
2. The SystemProxyDetector shall Wi-Fi、Ethernet、Thunderbolt Ethernetの複数のネットワークインターフェースを順番に確認する
3. When ネットワークインターフェースでプロキシが有効な場合, the SystemProxyDetector shall サーバーとポートの情報を抽出して`http://server:port`形式で返却する
4. If 特定のネットワークインターフェースが存在しない場合, then the SystemProxyDetector shall 次のインターフェースの検出を試みる
5. The GitConfigManager shall macOS環境での`git config`コマンド実行を正常に処理する
6. The NpmConfigManager shall macOS環境での`npm config`コマンド実行を正常に処理する
7. The TerminalEnvConfigManager shall macOS環境での統合ターミナル環境変数設定を正常に処理する

### Requirement 4: Linuxプラットフォーム対応
**Objective:** As a Linux環境のユーザー, I want Windowsと同等のプロキシ管理機能を利用したい, so that Linuxでも効率的にプロキシ設定を管理できる

#### Acceptance Criteria
1. When プラットフォームが`linux`の場合, the SystemProxyDetector shall `gsettings`コマンドを使用してGNOMEシステムプロキシを検出する
2. When GNOMEプロキシモードが`manual`の場合, the SystemProxyDetector shall `org.gnome.system.proxy.http`からホストとポートを取得する
3. The SystemProxyDetector shall 取得したホストとポートを`http://host:port`形式で返却する
4. If gsettingsが利用できない環境の場合, then the SystemProxyDetector shall エラーログを出力してnullを返す
5. The GitConfigManager shall Linux環境での`git config`コマンド実行を正常に処理する
6. The NpmConfigManager shall Linux環境での`npm config`コマンド実行を正常に処理する
7. The TerminalEnvConfigManager shall Linux環境での統合ターミナル環境変数設定を正常に処理する

### Requirement 5: クロスプラットフォームのプロキシ検出優先順位
**Objective:** As a ユーザー, I want すべてのプラットフォームで一貫したプロキシ検出の優先順位を適用したい, so that 予測可能な動作を期待できる

#### Acceptance Criteria
1. The SystemProxyDetector shall 設定された優先順位（デフォルト: environment, vscode, platform）に従ってプロキシを検出する
2. When 環境変数ソース（HTTP_PROXY、HTTPS_PROXY）でプロキシが検出された場合, the SystemProxyDetector shall プラットフォーム固有の検出をスキップする
3. When VSCode設定でプロキシが検出された場合, the SystemProxyDetector shall プラットフォーム固有の検出をスキップする
4. When 上位の検出ソースでプロキシが見つからない場合, the SystemProxyDetector shall プラットフォーム固有の検出にフォールバックする
5. The SystemProxyDetector shall 検出優先順位の動的な更新をサポートする

### Requirement 6: エラーハンドリングとフォールバック
**Objective:** As a ユーザー, I want プラットフォーム固有のエラーが適切に処理されること, so that エラー発生時も安定した動作を期待できる

#### Acceptance Criteria
1. If Windowsレジストリクエリが失敗した場合, then the SystemProxyDetector shall エラーをログに記録してnullを返す
2. If macOSの`networksetup`コマンドが失敗した場合, then the SystemProxyDetector shall エラーをログに記録してnullを返す
3. If Linuxの`gsettings`コマンドが失敗した場合, then the SystemProxyDetector shall エラーをログに記録してnullを返す
4. While プラットフォーム固有の検出が失敗している場合, the SystemProxyDetector shall 環境変数やVSCode設定からのフォールバック検出を試みる
5. If すべての検出ソースが失敗した場合, then the SystemProxyDetector shall `{ proxyUrl: null, source: null }`を返す
6. The SystemProxyDetector shall プラットフォーム固有のエラーメッセージをログに記録する

### Requirement 7: 検出結果の検証
**Objective:** As a ユーザー, I want 検出されたプロキシURLが有効であることを確認したい, so that 無効なプロキシ設定による問題を防ぐ

#### Acceptance Criteria
1. When プロキシURLが検出された場合, the SystemProxyDetector shall ProxyUrlValidatorを使用して検証する
2. If 検出されたプロキシURLが無効な場合, then the SystemProxyDetector shall 警告ログを出力して次の検出ソースを試みる
3. The ProxyUrlValidator shall すべてのプラットフォームで一貫したURL検証ロジックを適用する
4. The SystemProxyDetector shall 検証に合格したプロキシURLのみを返却する

### Requirement 8: パス区切り文字とコマンド実行の互換性
**Objective:** As a 開発者, I want すべてのプラットフォームでファイルパスとコマンド実行が正しく処理されること, so that プラットフォーム固有の問題を回避できる

#### Acceptance Criteria
1. The 拡張機能 shall Node.jsの`child_process.exec`を使用してクロスプラットフォーム互換のコマンド実行を行う
2. When コマンドを実行する場合, the 拡張機能 shall プラットフォーム固有のシェル構文を考慮する
3. The GitConfigManager shall グローバル設定ファイルのパスをプラットフォームに応じて正しく解決する
4. The NpmConfigManager shall npmrc設定ファイルのパスをプラットフォームに応じて正しく解決する

### Requirement 9: テストカバレッジ
**Objective:** As a 開発者, I want クロスプラットフォーム機能のテストカバレッジを確保したい, so that 各プラットフォームでの品質を担保できる

#### Acceptance Criteria
1. The テストスイート shall 各プラットフォーム（Windows、macOS、Linux）のプロキシ検出ロジックをモックテストできる
2. The テストスイート shall プラットフォーム固有のエラーケースをカバーする
3. The テストスイート shall 検出優先順位のフォールバック動作を検証する
4. When `process.platform`をモックした場合, the テストスイート shall 各プラットフォームの動作をシミュレートできる
