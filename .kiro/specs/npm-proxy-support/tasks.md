# 実装計画

- [x] 1. NpmConfigManagerクラスの作成





  - `src/config/NpmConfigManager.ts`ファイルを作成
  - OperationResultインターフェースを定義（GitConfigManagerと同じ構造）
  - NpmConfigManagerクラスの基本構造を実装
  - タイムアウト設定（5秒）を定義
  - _要件: 1.1, 2.1, 3.1, 4.3, 4.4_

- [x] 1.1 setProxy()メソッドの実装

  - execFile()を使用してnpm config set http-proxyを実行
  - execFile()を使用してnpm config set https-proxyを実行
  - タイムアウトとエンコーディングを設定
  - エラーハンドリングを実装
  - _要件: 1.1, 4.3, 4.4_

- [x] 1.2 unsetProxy()メソッドの実装

  - hasConfig()を使用して設定の存在を確認
  - http-proxyが存在する場合は削除
  - https-proxyが存在する場合は削除
  - エラーハンドリングを実装
  - _要件: 2.1_

- [x] 1.3 getProxy()メソッドの実装

  - execFile()を使用してnpm config get http-proxyを実行
  - 設定が存在しない場合はnullを返す
  - エラーをログに記録してnullを返す
  - _要件: 3.1, 3.2_

- [x] 1.4 hasConfig()プライベートメソッドの実装

  - 指定されたnpm設定キーの存在を確認
  - エラーが発生した場合はfalseを返す
  - _要件: 2.1_

- [x] 1.5 handleError()プライベートメソッドの実装

  - エラーメッセージとstderrを解析
  - NOT_INSTALLED、NO_PERMISSION、TIMEOUT、CONFIG_ERROR、UNKNOWNを判定
  - 適切なエラーメッセージを生成
  - OperationResultを返す
  - _要件: 1.4, 2.2, 5.1, 5.4_

- [x] 1.6 NpmConfigManagerのユニットテストを作成


  - `src/test/NpmConfigManager.test.ts`ファイルを作成
  - setProxy()の正常系テスト
  - unsetProxy()の正常系テスト
  - getProxy()の正常系テスト
  - npmが未インストールのエラーケース（例）
  - 権限エラーのケース（例）
  - タイムアウトのケース（例）
  - _要件: 1.1, 1.4, 2.1, 3.1, 3.2, 3.3, 4.4_

- [x] 1.7 プロパティテスト: npm proxy設定の適用


  - **プロパティ1: npm proxy設定の適用**
  - **検証対象: 要件 1.1**

- [x] 1.8 プロパティテスト: 設定取得のラウンドトリップ

  - **プロパティ7: 設定取得のラウンドトリップ**
  - **検証対象: 要件 3.1**

- [x] 2. extension.tsへのnpm設定統合





  - NpmConfigManagerをインポート
  - npmConfigManagerインスタンスを作成
  - ProxyStateインターフェースにnpmConfiguredフィールドを追加
  - _要件: 1.2, 1.3, 2.3, 5.3_

- [x] 2.1 updateNpmProxy()関数の実装


  - enabledがtrueの場合はnpmConfigManager.setProxy()を呼び出す
  - enabledがfalseの場合はnpmConfigManager.unsetProxy()を呼び出す
  - 結果が失敗の場合はエラーをログに記録してthrow
  - _要件: 1.1, 2.1, 4.3_

- [x] 2.2 applyProxySettings()関数の更新


  - updateNpmProxy()呼び出しを追加
  - npmSuccessフラグを追加
  - エラーをErrorAggregatorに追加
  - ProxyStateのnpmConfiguredを更新
  - 成功判定にnpmSuccessを含める
  - _要件: 1.2, 1.3, 4.1, 5.1, 5.2, 5.3_

- [x] 2.3 disableProxySettings()関数の更新


  - npmConfigManager.unsetProxy()呼び出しを追加
  - npmSuccessフラグを追加
  - エラーをErrorAggregatorに追加
  - ProxyStateのnpmConfiguredを更新
  - 成功判定にnpmSuccessを含める
  - _要件: 2.1, 2.2, 2.3, 5.1, 5.2_

- [x] 2.4 プロパティテスト: 設定の一貫性


  - **プロパティ2: 設定の一貫性**
  - **検証対象: 要件 1.2**

- [x] 2.5 プロパティテスト: エラー分離

  - **プロパティ3: エラー分離**
  - **検証対象: 要件 1.3, 5.1, 5.3**

- [x] 2.6 プロパティテスト: 削除操作の一貫性

  - **プロパティ6: 削除操作の一貫性**
  - **検証対象: 要件 2.3**

- [x] 3. エラーハンドリングの強化


  - UserNotifierでnpmエラーメッセージを表示
  - トラブルシューティング提案を追加
  - ErrorAggregatorでnpmエラーを集約
  - _要件: 2.2, 5.1, 5.2, 5.4_

- [x] 3.1 プロパティテスト: 削除エラーのハンドリング
  - **プロパティ5: 削除エラーのハンドリング**
  - **検証対象: 要件 2.2**

- [x] 3.2 プロパティテスト: エラー集約と通知
  - **プロパティ10: エラー集約と通知**
  - **検証対象: 要件 5.2**

- [x] 3.3 プロパティテスト: エラーメッセージの提案
  - **プロパティ11: エラーメッセージの提案**
  - **検証対象: 要件 5.4**

- [x] 4. セキュリティとバリデーション


  - applyProxySettings()でProxyUrlValidatorを使用してnpm設定前に検証
  - InputSanitizerを使用してnpm関連のログ出力をサニタイズ
  - エラーメッセージにクレデンシャルが含まれないことを確認
  - _要件: 4.1, 4.2_

- [x] 4.1 プロパティテスト: 無効URL拒否
  - **プロパティ8: 無効URL拒否**
  - **検証対象: 要件 4.1**

- [x] 4.2 プロパティテスト: クレデンシャルマスキング
  - **プロパティ9: クレデンシャルマスキング**
  - **検証対象: 要件 4.2**

- [x] 5. チェックポイント - すべてのテストが通ることを確認


  - すべてのテストが通ることを確認し、問題があればユーザーに質問する

- [x] 6. 統合テスト
  - npm設定を含む完全なapplyProxySettings()フローのテスト
  - npm設定を含む完全なdisableProxySettings()フローのテスト
  - npm設定エラー時の他の設定継続のテスト
  - エラー集約と通知の統合テスト
  - _要件: すべて_

- [x] 7. プロパティテスト: proxy設定の削除
  - **プロパティ4: proxy設定の削除**
  - **検証対象: 要件 2.1**
