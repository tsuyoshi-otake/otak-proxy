# Implementation Plan

## Status Summary
- Phase 1-5: **完了** - extension.ts: 914→855行
- Phase 6-7: **完了** - extension.ts: 855→469行（45%削減）
- Phase 8-10: 未着手

---

## Phase 1: 型定義の抽出

- [x] 1. Create core/types.ts
  - `core/types.ts`を作成し、ProxyMode enum、ProxyState interface、CommandContext interfaceを定義
  - _Requirements: 1.1, 1.2, 1.5_

- [x] 1.1 Write unit tests for type definitions
  - core/types.tsの型定義が正しくエクスポートされることを確認
  - _Requirements: 1.3_

- [x] 1.2 Integrate core/types.ts into extension.ts
  - extension.tsのProxyMode enum、ProxyState interfaceを削除
  - core/types.tsからインポートするように変更
  - _Requirements: 1.1, 1.2_

---

## Phase 2: ユーティリティ関数の抽出

- [x] 2. Create utils/ProxyUtils.ts
  - `utils/ProxyUtils.ts`を作成
  - validateProxyUrl, sanitizeProxyUrl, testProxyConnection, detectSystemProxySettingsを定義
  - _Requirements: 6.1, 6.2_

- [x] 2.1 Write unit tests for ProxyUtils
  - 各ユーティリティ関数の動作を検証
  - _Requirements: 1.3_

- [x] 2.2 Integrate utils/ProxyUtils.ts into extension.ts
  - extension.tsの重複関数を削除
  - utils/ProxyUtils.tsからインポートするように変更
  - _Requirements: 6.1, 6.2_

---

## Phase 3: 状態管理の分離

- [x] 3. Create core/ProxyStateManager.ts
  - `core/ProxyStateManager.ts`を作成
  - ProxyStateManagerクラスを実装（getState, saveState, getActiveProxyUrl, getNextMode, migrateOldSettings）
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 3.1 Write property test for state persistence fallback
  - **Property 3: State persistence fallback**
  - **Validates: Requirements 3.2**
  - globalState.updateの失敗時にin-memoryフォールバックが機能することを検証
  - _Requirements: 3.2_

- [x] 3.2 Write property test for legacy state migration
  - **Property 4: Legacy state migration**
  - **Validates: Requirements 3.3**
  - 様々な古い形式の状態データが正しく移行されることを検証
  - _Requirements: 3.3_

- [x] 3.3 Write unit tests for ProxyStateManager
  - getState, saveState, getActiveProxyUrl, getNextModeの動作を検証
  - _Requirements: 1.3_

- [x] 3.4 Integrate ProxyStateManager into extension.ts
  - extension.tsの状態管理関数をラッパーに置き換え
  - ProxyStateManagerのインスタンスを使用するように変更
  - _Requirements: 3.1, 3.2, 3.3_

---

## Phase 4: 設定適用ロジックの分離

- [x] 4. Create core/ProxyApplier.ts
  - `core/ProxyApplier.ts`を作成
  - ProxyApplierクラスを実装（applyProxy, disableProxy, updateManager）
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 4.1 Write property test for proxy enablement sequence
  - **Property 5: Proxy enablement sequence**
  - **Validates: Requirements 4.2**
  - プロキシ有効化時にバリデーション→適用→エラー集約の順序で実行されることを検証
  - _Requirements: 4.2_

- [x] 4.2 Write property test for proxy disablement completeness
  - **Property 6: Proxy disablement completeness**
  - **Validates: Requirements 4.3**
  - プロキシ無効化時にすべてのConfigManagerのunsetが呼び出されることを検証
  - _Requirements: 4.3_

- [x] 4.3 Write property test for error aggregation
  - **Property 7: Error aggregation on failure**
  - **Validates: Requirements 4.4**
  - ConfigManager失敗時にErrorAggregatorにエラーが追加されることを検証
  - _Requirements: 4.4_

- [x] 4.4 Write unit tests for ProxyApplier
  - applyProxy, disableProxyの動作を検証
  - _Requirements: 1.3_

- [x] 4.5 Integrate ProxyApplier into extension.ts
  - extension.tsのapplyProxySettings等をラッパーに置き換え（257行削減）
  - ProxyApplierのインスタンスを使用するように変更
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

---

## Phase 5: ステータスバー管理の分離

- [x] 5. Create ui/StatusBarManager.ts
  - `ui/StatusBarManager.ts`を作成（現在は空ファイル）
  - StatusBarManagerクラスを実装（constructor, update, updateText, updateTooltip, validateCommandLinks）
  - extension.tsからinitializeStatusBar, updateStatusBarを移動
  - extension.tsでStatusBarManagerのインスタンスを作成
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 5.1 Write property test for status bar state reflection
  - **Property 8: Status bar state reflection**
  - **Validates: Requirements 5.2**
  - 様々なProxyStateに対して適切なテキストとツールチップが生成されることを検証
  - _Requirements: 5.2_

- [x] 5.2 Write property test for command link validation
  - **Property 9: Command link validation**
  - **Validates: Requirements 5.3**
  - ツールチップ内のコマンドリンクが登録済みコマンドを参照していることを検証
  - _Requirements: 5.3_

- [x] 5.3 Write property test for status bar internationalization
  - **Property 10: Status bar internationalization**
  - **Validates: Requirements 5.4**
  - 様々なロケールでステータスバーテキストが翻訳されることを検証
  - _Requirements: 5.4_

- [x] 5.4 Write unit tests for StatusBarManager
  - update, updateText, updateTooltipの動作を検証
  - _Requirements: 1.3_

---

## Phase 6: コマンドの分離

- [x] 6. Create command files
  - `commands/types.ts`を作成（CommandContext, CommandResult）
  - `commands/ToggleProxyCommand.ts`を作成し、executeToggleProxy関数を実装
  - `commands/ConfigureUrlCommand.ts`を作成し、executeConfigureUrl関数を実装
  - `commands/TestProxyCommand.ts`を作成し、executeTestProxy関数を実装
  - `commands/ImportProxyCommand.ts`を作成し、executeImportProxy関数を実装
  - `commands/CommandRegistry.ts`を作成（Phase 7を統合）
  - `commands/index.ts`を作成（モジュールエクスポート）
  - extension.tsをCommandRegistry統合で469行に削減（45%削減）
  - _Requirements: 2.1, 2.2, 2.3, 6.2, 6.3_

- [x] 6.1 Write property test for command error handling
  - **Property 1: Command error handling consistency**
  - **Validates: Requirements 2.3**
  - 任意のコマンドでエラーが発生した場合に適切にハンドリングされることを検証
  - _Requirements: 2.3_

- [x] 6.2 Write property test for command independence
  - **Property 2: Command independence**
  - **Validates: Requirements 2.4**
  - 異なるコマンドを順次実行しても互いに影響しないことを検証
  - _Requirements: 2.4_

- [x] 6.3 Write unit tests for each command
  - 既存のstatusbar-commands.test.tsで検証
  - _Requirements: 1.3_

---

## Phase 7: コマンド登録の統一

- [x] 7. Create commands/CommandRegistry.ts
  - Phase 6で統合実装済み
  - CommandRegistryクラスを実装（registerAll, 各コマンドの登録メソッド）
  - extension.tsのregisterCommands関数をCommandRegistryに移動
  - 設定変更リスナーとウィンドウフォーカスリスナーも移動
  - _Requirements: 2.2_

- [x] 7.1 Write unit tests for CommandRegistry
  - 既存テストで検証（389 passing）
  - _Requirements: 1.3_

---

## Phase 8: エントリーポイントの簡素化

- [x] 8. Simplify extension.ts





  - extension.tsを簡素化（activate, deactivate, performInitialSetupのみ残す）
  - 各モジュールのインスタンス化とCommandRegistryの呼び出しを実装
  - askForInitialSetup, initializeProxyMonitor, startSystemProxyMonitoring, stopSystemProxyMonitoringを適切な場所に移動
  - _Requirements: 1.1, 1.2_

- [x] 8.1 Verify all existing tests pass


  - すべての既存テストスイートを実行して合格を確認
  - _Requirements: 1.3_


- [x] 8.2 Verify file size constraints

  - 各ファイルが300行以下であることを確認
  - extension.tsが100行程度であることを確認
  - _Requirements: 1.2_


- [x] 8.3 Verify no circular dependencies

  - madgeなどのツールで循環依存がないことを確認
  - _Requirements: 1.4_

- [x] 8.4 Verify folder structure


  - core/, commands/, ui/, utils/フォルダが存在することを確認
  - _Requirements: 1.5_

---

## Phase 9: テストパフォーマンス最適化

- [x] 9. Test performance optimization





  - `.vscode-test.mjs`を更新して並列実行を有効化
  - 環境変数による実行回数制御を実装（CI: 100回、開発: 10回）
  - プロパティベーステストの実行回数を環境変数で制御
  - _Requirements: 7.1, 7.3_

- [x] 9.1 Create test configuration helper


  - テスト実行回数を環境変数で制御するヘルパー関数を作成
  - _Requirements: 7.1_

- [x] 9.2 Update property-based tests to use configuration


  - すべてのプロパティベーステストで実行回数制御を適用
  - _Requirements: 7.1_

- [x] 9.3 Measure test execution time


  - リファクタリング前後のテスト実行時間を測定して比較
  - _Requirements: 7.4_

---

## Phase 10: ドキュメントとクリーンアップ

- [x] 10. Documentation and cleanup





  - 各モジュールにJSDocコメントを追加
  - READMEを更新してアーキテクチャの変更を記載
  - 不要なコメントや古いコードを削除
  - _Requirements: 1.1_



- [x] 10.1 Update architecture documentation




  - 新しいフォルダ構造とモジュール構成をドキュメント化
  - _Requirements: 1.5_

---

## Final Checkpoint



- [x] 11. Final verification



  - すべてのテストが合格することを確認
  - Ensure all tests pass, ask the user if questions arise.
