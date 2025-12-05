# 要件定義書

## はじめに

本拡張機能は現在VSCodeとGitのproxy設定を管理していますが、npmのproxy設定にも対応することで、開発者がproxy環境下でnpmパッケージのインストールや公開を円滑に行えるようにします。既存のVSCodeとGitの設定と同様に、npmのproxy設定も一元管理し、ワンクリックで切り替えられるようにします。

## 用語集

- **npm**: Node Package Managerの略。JavaScriptパッケージマネージャー
- **npmrc**: npmの設定ファイル。ユーザーレベルとプロジェクトレベルが存在
- **proxy設定**: HTTPリクエストを中継サーバー経由で行うための設定
- **https-proxy**: HTTPS通信用のproxy設定
- **システム**: 本拡張機能全体を指す
- **NpmConfigManager**: npmの設定を管理するクラス

## 要件

### 要件 1

**ユーザーストーリー:** 開発者として、proxy環境下でnpmパッケージをインストールできるように、npmのproxy設定を自動的に適用してほしい

#### 受入基準

1. WHEN ユーザーがproxy設定を有効化する THEN システムはnpmのproxy設定（http-proxyとhttps-proxy）を設定する
2. WHEN npmの設定が適用される THEN システムは既存のVSCodeとGitの設定と同じproxy URLを使用する
3. WHEN npmの設定に失敗する THEN システムはエラーを記録し、他の設定（VSCodeとGit）の適用を継続する
4. WHEN npmがインストールされていない THEN システムは警告を表示するが、拡張機能の動作を継続する

### 要件 2

**ユーザーストーリー:** 開発者として、proxyを無効化したときにnpmの設定もクリアされるように、一貫した動作を期待する

#### 受入基準

1. WHEN ユーザーがproxyを無効化する THEN システムはnpmのproxy設定を削除する
2. WHEN npm設定の削除に失敗する THEN システムはエラーを記録し、ユーザーに通知する
3. WHEN npm設定の削除が成功する THEN システムは他の設定（VSCodeとGit）の削除も実行する

### 要件 3

**ユーザーストーリー:** 開発者として、npmの設定が正しく適用されているか確認できるように、現在の設定を取得できるようにしてほしい

#### 受入基準

1. WHEN システムがnpmの現在の設定を取得する THEN システムはhttp-proxyとhttps-proxyの値を返す
2. WHEN npm設定の取得に失敗する THEN システムは空の結果を返し、エラーをログに記録する
3. WHEN npmがインストールされていない THEN システムは適切なエラーメッセージを返す

### 要件 4

**ユーザーストーリー:** 開発者として、npmの設定が他のツール（VSCodeとGit）と同じセキュリティ基準を満たすように、入力検証とクレデンシャル保護を適用してほしい

#### 受入基準

1. WHEN npmにproxy URLを設定する前に THEN システムはProxyUrlValidatorを使用してURLを検証する
2. WHEN npmの設定をログに出力する THEN システムはInputSanitizerを使用してクレデンシャルをマスクする
3. WHEN npmコマンドを実行する THEN システムはexecFile()を使用してコマンドインジェクションを防止する
4. WHEN npm設定にタイムアウトを設定する THEN システムは5秒のタイムアウトを適用する

### 要件 5

**ユーザーストーリー:** 開発者として、npmの設定エラーが他のツールの設定に影響しないように、エラーハンドリングを分離してほしい

#### 受入基準

1. WHEN npm設定でエラーが発生する THEN システムはErrorAggregatorにエラーを追加する
2. WHEN すべての設定操作が完了する THEN システムは集約されたエラーをUserNotifierで表示する
3. WHEN npm設定が失敗する THEN システムはVSCodeとGitの設定を継続する
4. WHEN npmのエラーメッセージを表示する THEN システムはトラブルシューティングの提案を含める
