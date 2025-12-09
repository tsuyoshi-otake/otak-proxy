# Implementation Plan

- [x] 1. ProxyUtils の並列テスト機能を実装

- [x] 1.1 testProxyConnectionParallel 関数を作成
  - Promise.race() を使用して複数のテストURLを並列実行
  - 最初に成功したテストで即座に完了
  - タイムアウトパラメータをサポート
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 1.2 testProxyConnectionParallel のユニットテストを作成
  - 並列実行の動作をテスト
  - 早期終了のロジックをテスト
  - タイムアウト処理をテスト
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 1.3 プロパティテストを作成: 並列テストの早期終了
  - **Property 4: 並列テストの早期終了**
  - **Validates: Requirements 2.2, 2.4**
  - ランダムな数のテストURL（1-5個）とテスト結果を生成し、1つでも成功すれば全体が成功することを確認
  - 最小30回のイテレーション

- [x] 1.4 既存の testProxyConnection 関数を拡張
  - TestOptions インターフェースを追加
  - parallel オプションをサポート
  - timeout オプションをサポート
  - _Requirements: 2.1, 2.3_

- [x] 2. ProxyConnectionTester クラスを実装

- [x] 2.1 ProxyConnectionTester クラスを作成
  - testProxyAuto メソッドを実装（3秒タイムアウト、並列実行）
  - testProxyManual メソッドを実装（5秒タイムアウト、詳細結果）
  - 最後のテスト結果をキャッシュ
  - テスト中フラグを管理
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 7.1, 7.2_

- [x] 2.2 ProxyConnectionTester のユニットテストを作成
  - testProxyAuto メソッドをテスト
  - testProxyManual メソッドをテスト
  - テスト結果のキャッシュをテスト
  - テスト中フラグの管理をテスト
  - _Requirements: 1.1, 2.1, 2.2, 2.3, 7.1, 7.2_

- [x] 2.3 プロパティテストを作成: テスト成功時のプロキシ有効化
  - **Property 2: テスト成功時のプロキシ有効化**
  - **Validates: Requirements 1.2, 4.2, 5.2**
  - ランダムなプロキシURLとテスト結果（成功）を生成し、プロキシが有効化されることを確認
  - 最小30回のイテレーション

- [x] 2.4 プロパティテストを作成: テスト失敗時のプロキシ無効化
  - **Property 3: テスト失敗時のプロキシ無効化**
  - **Validates: Requirements 1.3, 4.3, 5.3**
  - ランダムなプロキシURLとテスト結果（失敗）を生成し、プロキシが無効化されることを確認
  - 最小30回のイテレーション

- [x] 2.5 テスト結果の通知機能を実装
  - 自動テスト時は簡潔な通知
  - 手動テスト時は詳細な通知
  - NotificationThrottler を使用して重複を抑制
  - _Requirements: 6.1, 6.2, 6.3, 7.3, 7.4_

- [x] 2.6 プロパティテストを作成: 通知の重複抑制
  - **Property 7: 通知の重複抑制**
  - **Validates: Requirements 6.3**
  - ランダムな通知イベントのシーケンスを生成し、短時間に同じ通知が複数回表示されないことを確認
  - 最小30回のイテレーション

- [x] 3. ProxyTestScheduler クラスを実装

- [x] 3.1 ProxyTestScheduler クラスを作成
  - start メソッドを実装（定期テスト開始）
  - stop メソッドを実装（定期テスト停止）
  - updateInterval メソッドを実装（テスト間隔更新）
  - updateProxyUrl メソッドを実装（プロキシURL更新）
  - triggerImmediateTest メソッドを実装（即座のテスト実行）
  - _Requirements: 3.1, 3.4, 8.2_

- [x] 3.2 ProxyTestScheduler のユニットテストを作成
  - start/stop メソッドをテスト
  - updateInterval メソッドをテスト
  - updateProxyUrl メソッドをテスト
  - triggerImmediateTest メソッドをテスト
  - _Requirements: 3.1, 3.4, 8.2_

- [x] 3.3 プロパティテストを作成: 設定変更時のタイマー更新
  - **Property 10: 設定変更時のタイマー更新**
  - **Validates: Requirements 8.2**
  - ランダムなテスト間隔の変更を生成し、新しい間隔でタイマーが再設定されることを確認
  - 最小30回のイテレーション

- [x] 3.4 プロパティテストを作成: 定期テストによる状態更新
  - **Property 5: 定期テストによる状態更新**
  - **Validates: Requirements 3.2, 3.3**
  - ランダムなプロキシ状態とテスト結果を生成し、テスト結果に基づいてプロキシ状態が更新されることを確認
  - 最小30回のイテレーション

- [x] 4. ProxyMonitor に接続テスト機能を統合

- [x] 4.1 ProxyMonitor に ProxyConnectionTester を統合
  - executeCheck メソッドを拡張して接続テストを実行
  - テスト結果に基づいてプロキシ状態を決定
  - 新しいイベント（proxyTestComplete, proxyStateChanged）を追加
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 4.2 ProxyMonitor の統合テストを作成
  - 接続テスト統合の動作をテスト
  - テスト結果に基づく状態管理をテスト
  - イベント発行をテスト
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 4.3 プロパティテストを作成: システムプロキシ検出時のテスト実行
  - **Property 1: システムプロキシ検出時のテスト実行**
  - **Validates: Requirements 1.1**
  - ランダムなプロキシURLを生成し、検出時に接続テストが呼び出されることを確認
  - 最小30回のイテレーション

- [x] 4.4 ProxyMonitor に ProxyTestScheduler を統合
  - Autoモード開始時に定期テストを開始
  - Autoモード停止時に定期テストを停止
  - プロキシURL変更時にスケジューラーを更新
  - _Requirements: 3.1, 3.4, 5.1_

- [x] 4.5 プロパティテストを作成: プロキシURL変更時の即座のテスト
  - **Property 6: プロキシURL変更時の即座のテスト**
  - **Validates: Requirements 5.1**
  - ランダムなプロキシURL変更イベントを生成し、変更時に接続テストが呼び出されることを確認
  - 最小30回のイテレーション

- [x] 5. ProxyState を拡張

- [x] 5.1 ProxyState インターフェースに新しいフィールドを追加
  - lastTestResult フィールドを追加
  - proxyReachable フィールドを追加
  - lastTestTimestamp フィールドを追加
  - _Requirements: 1.2, 1.3_

- [x] 5.2 ProxyStateManager を更新
  - 新しいフィールドの保存と読み込みをサポート
  - 既存の状態ファイルとの互換性を維持
  - _Requirements: 1.2, 1.3_

- [x] 5.3 ProxyStateManager のユニットテストを更新
  - 新しいフィールドの保存と読み込みをテスト
  - 後方互換性をテスト
  - _Requirements: 1.2, 1.3_

- [x] 6. ExtensionInitializer に起動時テストを統合

- [x] 6.1 ExtensionInitializer を更新
  - 起動時に ProxyConnectionTester を初期化
  - Autoモードの場合、起動直後に接続テストを実行
  - テスト完了までプロキシ状態を未確定として扱う
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 6.2 ExtensionInitializer の統合テストを作成
  - 起動時のテストフローをテスト
  - テスト結果に基づく状態管理をテスト
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 7. 設定項目を追加

- [x] 7.1 package.json に設定項目を追加
  - otakProxy.testInterval 設定を追加（デフォルト60秒、範囲30-600秒）
  - otakProxy.autoTestEnabled 設定を追加（デフォルトtrue）
  - _Requirements: 8.1, 8.3_

- [x] 7.2 設定変更のリスナーを実装
  - testInterval 変更時に ProxyTestScheduler を更新
  - autoTestEnabled 変更時に定期テストを開始/停止
  - _Requirements: 8.2, 8.4_

- [x] 7.3 プロパティテストを作成: テスト間隔設定の範囲検証
  - **Property 9: テスト間隔設定の範囲検証**
  - **Validates: Requirements 8.3**
  - ランダムなテスト間隔の設定値を生成（-100〜1000秒）し、30秒〜600秒の範囲にクランプされることを確認
  - 最小30回のイテレーション

- [x] 8. 国際化メッセージを追加

- [x] 8.1 新しいメッセージキーを追加
  - en.json と ja.json に接続テスト関連のメッセージを追加
  - 「プロキシ接続テスト中」、「プロキシが有効化されました」、「プロキシが無効化されました」などのメッセージ
  - _Requirements: 6.1, 6.2_

- [x] 9. 通知のデバウンス機能を実装

- [x] 9.1 連続状態変化時のデバウンスロジックを実装
  - 短時間に複数の状態変化が発生した場合、最後の状態のみを通知
  - デバウンス時間は1秒に設定
  - _Requirements: 6.4_

- [x] 9.2 プロパティテストを作成: 連続状態変化時の最終状態通知
  - **Property 8: 連続状態変化時の最終状態通知**
  - **Validates: Requirements 6.4**
  - ランダムな状態変化のシーケンスを生成し、最後の状態のみが通知されることを確認
  - 最小30回のイテレーション

- [x] 10. チェックポイント - すべてのテストが通ることを確認
  - すべてのテストが通ることを確認し、問題があればユーザーに質問する

- [x] 11. 統合テストを作成

- [x] 11.1 起動時のテストフローの統合テストを作成
  - VSCode起動 → Autoモード検出 → システムプロキシ検出 → 接続テスト → プロキシ有効化/無効化のフローをテスト
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 11.2 定期テストフローの統合テストを作成
  - 定期テスト開始 → テスト実行 → テスト結果に基づく状態更新 → 通知表示のフローをテスト
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 11.3 プロキシ変更フローの統合テストを作成
  - システムプロキシ変更検知 → 即座にテスト実行 → テスト結果に基づく状態更新 → 通知表示のフローをテスト
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 11.4 手動テストフローの統合テストを作成
  - ユーザーがテストコマンド実行 → 詳細テスト実行 → 詳細結果表示のフローをテスト
  - _Requirements: 7.1, 7.3_

- [x] 12. 最終チェックポイント - すべてのテストが通ることを確認
  - すべてのテストが通ることを確認し、問題があればユーザーに質問する
