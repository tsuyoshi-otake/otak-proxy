# Requirements Document

## Introduction

ステータスバーのツールチップに表示されるコマンドボタン（Configure Manual、Import System、Test Proxy等）が、インストール直後や特定の状態で押せない問題を解決する。すべてのコマンドボタンは、拡張機能がアクティブになった時点から常に実行可能であるべきである。

## Glossary

- **StatusBar**: VSCodeのウィンドウ下部に表示される情報バー
- **Tooltip**: ステータスバーアイテムにマウスオーバーした際に表示される吹き出し
- **Command Link**: ツールチップ内のクリック可能なコマンドリンク
- **Extension Context**: 拡張機能の実行コンテキスト
- **ProxyState**: プロキシの現在の状態を保持するオブジェクト

## Requirements

### Requirement 1

**User Story:** ユーザーとして、拡張機能をインストールした直後から、ステータスバーのツールチップ内のすべてのコマンドボタンを実行できるようにしたい。これにより、初期設定をスムーズに行える。

#### Acceptance Criteria

1. WHEN the extension is activated THEN the system SHALL register all command handlers before displaying the status bar
2. WHEN a user hovers over the status bar item THEN the system SHALL display all command links as clickable
3. WHEN a user clicks any command link in the tooltip THEN the system SHALL execute the corresponding command without errors
4. WHEN the extension state is not fully initialized THEN the system SHALL handle command execution gracefully with appropriate user feedback

### Requirement 2

**User Story:** ユーザーとして、プロキシが未設定の状態でも「Configure Manual」コマンドを実行できるようにしたい。これにより、初回設定を開始できる。

#### Acceptance Criteria

1. WHEN a user clicks "Configure Manual" with no proxy configured THEN the system SHALL display the proxy URL input dialog
2. WHEN a user enters a valid proxy URL THEN the system SHALL save it and update the status bar
3. WHEN a user cancels the input dialog THEN the system SHALL maintain the current state without errors
4. WHEN a user enters an invalid proxy URL THEN the system SHALL display validation errors and allow retry

### Requirement 3

**User Story:** ユーザーとして、プロキシが未設定の状態でも「Test Proxy」コマンドを実行できるようにしたい。適切なエラーメッセージが表示されることで、次に何をすべきか理解できる。

#### Acceptance Criteria

1. WHEN a user clicks "Test Proxy" with no proxy configured THEN the system SHALL display an informative error message
2. WHEN the error message is displayed THEN the system SHALL include suggestions for configuring a proxy
3. WHEN a user clicks "Test Proxy" with a configured proxy THEN the system SHALL execute the connection test
4. WHEN the test completes THEN the system SHALL display the result with appropriate success or failure messages

### Requirement 4

**User Story:** ユーザーとして、「Import System」コマンドがシステムプロキシの検出状態に関わらず実行できるようにしたい。これにより、システムプロキシの検出を試みることができる。

#### Acceptance Criteria

1. WHEN a user clicks "Import System" THEN the system SHALL attempt to detect system proxy settings
2. WHEN system proxy is detected THEN the system SHALL display options to use or save the detected proxy
3. WHEN no system proxy is detected THEN the system SHALL display an informative message with suggestions
4. WHEN detection fails THEN the system SHALL handle the error gracefully and inform the user

### Requirement 5

**User Story:** 開発者として、コマンドの実行順序が適切に管理されるようにしたい。これにより、初期化が完了する前にコマンドが実行されることを防げる。

#### Acceptance Criteria

1. WHEN the extension activates THEN the system SHALL register all commands before showing the status bar
2. WHEN a command is executed THEN the system SHALL verify that required dependencies are initialized
3. WHEN dependencies are not ready THEN the system SHALL queue the command or display an appropriate message
4. WHEN the status bar is updated THEN the system SHALL ensure all command links reference registered commands
