# Requirements Document

## Introduction

このドキュメントは、VSCode拡張機能「otak-proxy」のAutoモードにおけるフォールバック機能と状態管理の改善要件を定義します。現在の実装では、システムプロキシが検出されない場合、Autoモードは単にプロキシを無効化します。しかし、ユーザーがManualモードで設定したプロキシURLが利用可能な場合、それをフォールバックとして使用することで、より柔軟なプロキシ管理が可能になります。

また、現在のAutoモードでは、プロキシが無効化された状態と完全なOFFモードが区別されていません。Autoモード内でのプロキシ無効化は「一時的な無効化」であり、システムプロキシが再び利用可能になれば自動的に有効化されるべきです。

## Glossary

- **System Proxy**: OSまたは環境変数から検出されるプロキシ設定
- **Manual Proxy**: ユーザーがManualモードで明示的に設定したプロキシURL
- **Fallback Proxy**: システムプロキシが検出されない場合に使用されるManual Proxy
- **Auto Mode**: システムプロキシを自動検出して使用するモード
- **Auto Mode OFF**: Autoモード内でプロキシが一時的に無効化されている状態（システムプロキシが再び利用可能になれば自動的に有効化される）
- **OFF Mode**: 拡張機能全体のプロキシ機能が完全に無効化されているモード
- **ProxyStateManager**: プロキシ状態を管理するクラス
- **ProxyConnectionTester**: プロキシ接続テストを実行するクラス

## Requirements

### Requirement 1

**User Story:** ユーザーとして、システムプロキシが検出されない場合でもManualプロキシが利用可能なら使用してほしいので、Autoモードでフォールバック機能が提供されることを望みます

#### Acceptance Criteria

1. WHEN Autoモードでシステムプロキシが検出されない場合 THEN システムはManualプロキシURLの存在を確認すること
2. WHEN ManualプロキシURLが存在する場合 THEN システムはそのプロキシに対して接続テストを実行すること
3. WHEN Manualプロキシの接続テストが成功した場合 THEN システムはそのプロキシを有効化すること
4. WHEN Manualプロキシの接続テストが失敗した場合 THEN システムはプロキシを無効化し、直接接続を使用すること
5. WHEN ManualプロキシURLが存在しない場合 THEN システムはプロキシを無効化し、直接接続を使用すること

### Requirement 2

**User Story:** ユーザーとして、フォールバックプロキシの使用状況を把握したいので、適切な通知とステータス表示が提供されることを望みます

#### Acceptance Criteria

1. WHEN フォールバックプロキシが使用される場合 THEN システムは「システムプロキシが検出されないため、Manualプロキシを使用しています」という通知を表示すること
2. WHEN フォールバックプロキシが有効化された場合 THEN ステータスバーに「Auto (Fallback)」と表示すること
3. WHEN システムプロキシが再び検出された場合 THEN システムは「システムプロキシに切り替えました」という通知を表示すること
4. WHEN フォールバックプロキシのテストが失敗した場合 THEN システムは「Manualプロキシも利用できません」という通知を表示すること

### Requirement 3

**User Story:** ユーザーとして、AutoモードのOFF状態と完全なOFFモードを区別したいので、状態管理が明確に分離されることを望みます

#### Acceptance Criteria

1. WHEN Autoモードでプロキシが無効化された場合 THEN システムは状態を「Auto Mode OFF」として記録すること
2. WHEN Auto Mode OFFの状態でシステムプロキシが検出された場合 THEN システムは自動的にプロキシを有効化すること
3. WHEN Auto Mode OFFの状態でフォールバックプロキシが利用可能になった場合 THEN システムは自動的にプロキシを有効化すること
4. WHEN 完全なOFFモードの場合 THEN システムはプロキシ検出やテストを一切実行しないこと

### Requirement 4

**User Story:** ユーザーとして、AutoモードのOFF状態を視覚的に理解したいので、ステータスバーに明確な表示が提供されることを望みます

#### Acceptance Criteria

1. WHEN Auto Mode OFFの状態の場合 THEN ステータスバーに「Auto (OFF)」と表示すること
2. WHEN 完全なOFFモードの場合 THEN ステータスバーに「OFF」と表示すること
3. WHEN ステータスバーのツールチップが表示される場合 THEN Auto Mode OFFと完全なOFFモードの違いを説明すること
4. WHEN Auto Mode OFFの状態でステータスバーをクリックした場合 THEN システムは即座に接続テストを実行すること

### Requirement 5

**User Story:** ユーザーとして、フォールバックプロキシの優先順位を理解したいので、プロキシ選択ロジックが明確に定義されることを望みます

#### Acceptance Criteria

1. WHEN Autoモードでプロキシを選択する場合 THEN システムは以下の優先順位を使用すること：1) システムプロキシ、2) Manualプロキシ（フォールバック）、3) 直接接続
2. WHEN システムプロキシとManualプロキシの両方が利用可能な場合 THEN システムはシステムプロキシを優先すること
3. WHEN システムプロキシが利用不可でManualプロキシが利用可能な場合 THEN システムはManualプロキシを使用すること
4. WHEN 両方のプロキシが利用不可の場合 THEN システムは直接接続を使用すること

### Requirement 6

**User Story:** ユーザーとして、定期テストでフォールバックプロキシも確認してほしいので、定期テストがフォールバックロジックを含むことを望みます

#### Acceptance Criteria

1. WHEN 定期テストが実行される場合 THEN システムはシステムプロキシを最初にテストすること
2. WHEN 定期テストでシステムプロキシが失敗した場合 THEN システムはManualプロキシをテストすること
3. WHEN 定期テストでManualプロキシが成功した場合 THEN システムはフォールバックプロキシを有効化すること
4. WHEN 定期テストで両方のプロキシが失敗した場合 THEN システムはAuto Mode OFFに切り替えること

### Requirement 7

**User Story:** ユーザーとして、プロキシ状態の履歴を把握したいので、状態変化がログに記録されることを望みます

#### Acceptance Criteria

1. WHEN プロキシ状態が変化する場合 THEN システムは変化の詳細をログに記録すること
2. WHEN フォールバックプロキシが使用される場合 THEN ログに「Fallback to Manual Proxy」と記録すること
3. WHEN Auto Mode OFFに切り替わる場合 THEN ログに「Auto Mode OFF (waiting for proxy)」と記録すること
4. WHEN システムプロキシに戻る場合 THEN ログに「Switched back to System Proxy」と記録すること

### Requirement 8

**User Story:** ユーザーとして、フォールバック機能を無効化したい場合があるので、設定でフォールバック機能をオフにできることを望みます

#### Acceptance Criteria

1. WHEN ユーザーが設定を開く場合 THEN システムはフォールバック機能の有効/無効を切り替える設定項目を提供すること
2. WHEN フォールバック機能が無効化されている場合 THEN システムはManualプロキシをフォールバックとして使用しないこと
3. WHEN フォールバック機能が無効化されている場合 THEN システムはシステムプロキシのみをテストすること
4. WHEN フォールバック設定が変更された場合 THEN システムは即座に新しい設定を適用すること
