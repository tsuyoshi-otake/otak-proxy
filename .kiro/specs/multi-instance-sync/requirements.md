# Requirements Document

## Introduction

本ドキュメントは、複数のVSCode/Cursorインスタンス間でotak-proxyの設定を同期する機能の要件を定義します。

現在、各インスタンスのotak-proxy拡張機能は独立して動作しており、1つのインスタンスでプロキシ設定を変更しても他のインスタンスには反映されません。この機能により、すべてのインスタンスで一貫したプロキシ状態を維持し、手動同期の手間を解消します。

## Requirements

### Requirement 1: インスタンス検出

**Objective:** As a 開発者, I want 他のotak-proxyインスタンスが起動していることを自動検出したい, so that 複数インスタンス間での設定同期が可能になる

#### Acceptance Criteria

1. When otak-proxy拡張機能が起動した時, the otak-proxy shall 同一マシン上で動作している他のotak-proxyインスタンスを検出する
2. When 新しいVSCode/Cursorインスタンスが起動した時, the otak-proxy shall 既存のインスタンスに対して自身の存在を通知する
3. When インスタンスが終了した時, the otak-proxy shall 他のインスタンスから自身を登録解除する
4. The otak-proxy shall インスタンスの存在確認を定期的に実行する

### Requirement 2: プロキシ設定の同期

**Objective:** As a 開発者, I want 1つのインスタンスで変更したプロキシ設定が他のすべてのインスタンスに反映されるようにしたい, so that 手動で各インスタンスを設定する手間が省ける

#### Acceptance Criteria

1. When プロキシモード（Off/Manual/Auto）が変更された時, the otak-proxy shall 変更を他のすべてのインスタンスに伝播する
2. When プロキシURL設定が変更された時, the otak-proxy shall 新しいURL設定を他のすべてのインスタンスに伝播する
3. When プロキシの有効化/無効化状態が変更された時, the otak-proxy shall 状態変更を他のすべてのインスタンスに伝播する
4. When 他のインスタンスから設定変更通知を受信した時, the otak-proxy shall ローカル設定を受信した設定で更新する
5. The otak-proxy shall 設定変更の伝播を1秒以内に完了する

### Requirement 3: 接続テスト結果の共有

**Objective:** As a 開発者, I want 1つのインスタンスで実行したプロキシ接続テストの結果を他のインスタンスでも確認したい, so that 重複したテスト実行を避けられる

#### Acceptance Criteria

1. When プロキシ接続テストが完了した時, the otak-proxy shall テスト結果（成功/失敗、タイムスタンプ）を他のインスタンスに共有する
2. When 他のインスタンスから接続テスト結果を受信した時, the otak-proxy shall ローカルのテスト結果表示を更新する
3. While 最新の接続テスト結果が存在する間, the otak-proxy shall 結果の鮮度（タイムスタンプ）を表示する

### Requirement 4: 競合解決

**Objective:** As a 開発者, I want 複数インスタンスで同時に設定変更が行われた場合に適切に処理されるようにしたい, so that データの不整合や設定の喪失が発生しない

#### Acceptance Criteria

1. When 複数のインスタンスが同時に設定を変更した時, the otak-proxy shall タイムスタンプに基づいて最新の変更を採用する
2. When 競合が検出された時, the otak-proxy shall 競合解決の結果をユーザーに通知する
3. If 設定の競合が発生した場合, the otak-proxy shall 競合した設定の詳細をログに記録する
4. The otak-proxy shall 競合解決において、ユーザーの直近の意図（最後の変更）を優先する

### Requirement 5: 同期メカニズム

**Objective:** As a 開発者, I want 信頼性の高い同期メカニズムが提供されるようにしたい, so that インスタンス間で確実に設定が同期される

#### Acceptance Criteria

1. The otak-proxy shall ファイルベースの同期メカニズムを使用してインスタンス間通信を実現する
2. The otak-proxy shall 共有設定ファイルへのアクセスをアトミックに行う
3. When 共有設定ファイルに変更が検出された時, the otak-proxy shall 変更内容をローカル設定に反映する
4. While VSCodeインスタンスがアクティブな間, the otak-proxy shall 共有設定ファイルの変更を監視する
5. If 共有設定ファイルへのアクセスに失敗した場合, the otak-proxy shall ローカル設定を維持して動作を継続する

### Requirement 6: ステータス表示

**Objective:** As a 開発者, I want 同期状態をステータスバーで確認したい, so that 設定が正しく同期されているかを把握できる

#### Acceptance Criteria

1. When 複数のインスタンスが検出された時, the otak-proxy shall ステータスバーに同期アイコンまたはインジケーターを表示する
2. When 設定の同期が進行中の時, the otak-proxy shall 同期中であることを視覚的に示す
3. If 同期エラーが発生した場合, the otak-proxy shall ステータスバーに警告を表示する
4. When ユーザーが同期ステータスアイコンをクリックした時, the otak-proxy shall 同期状態の詳細情報を表示する

### Requirement 7: エラーハンドリングと復旧

**Objective:** As a 開発者, I want 同期処理でエラーが発生しても拡張機能が正常に動作し続けるようにしたい, so that 同期機能の問題が通常のプロキシ管理機能に影響しない

#### Acceptance Criteria

1. If インスタンス間通信に失敗した場合, the otak-proxy shall エラーをログに記録し、ローカル動作を継続する
2. If 共有設定ファイルが破損している場合, the otak-proxy shall ファイルを再作成して正常な状態に復旧する
3. When 同期エラーから復旧した時, the otak-proxy shall 自動的に最新の設定を再同期する
4. The otak-proxy shall 同期機能の障害が発生しても、単独インスタンスとしての全機能を維持する
5. If 同期が30秒以上応答しない場合, the otak-proxy shall タイムアウトとして処理し、再試行をスケジュールする

### Requirement 8: 設定とカスタマイズ

**Objective:** As a 開発者, I want 同期機能の動作をカスタマイズしたい, so that 自分のワークフローに合った設定ができる

#### Acceptance Criteria

1. The otak-proxy shall 同期機能の有効/無効を切り替える設定オプションを提供する
2. Where 同期機能が無効化されている場合, the otak-proxy shall 単独インスタンスモードで動作する
3. The otak-proxy shall 同期の更新間隔を設定するオプションを提供する
4. When 同期設定が変更された時, the otak-proxy shall 再起動なしで新しい設定を適用する
