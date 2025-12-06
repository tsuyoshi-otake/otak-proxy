# Requirements Document

## Introduction

この機能は、otak-proxy VS Code拡張機能のユーザーインターフェースを多言語化（国際化）するものです。現在、すべてのメッセージとUIテキストが英語でハードコードされていますが、これを日本語と英語に対応させ、ユーザーの環境に応じて自動的に適切な言語を選択できるようにします。VS CodeのLanguage Packが導入されている場合は、その言語設定を自動検出し、対応する言語でUIを表示します。対応していない言語の場合は、英語をフォールバック言語として使用します。

## Glossary

- **Extension**: VS Code拡張機能（otak-proxy）
- **i18n**: Internationalization（国際化）の略称
- **Language Pack**: VS Codeの言語パック。UIの表示言語を変更するためのパッケージ
- **Locale**: ユーザーの言語・地域設定（例: "ja"は日本語、"en"は英語）
- **Message Bundle**: 特定の言語用の翻訳メッセージを格納したファイル
- **Fallback Language**: 対応する言語が見つからない場合に使用されるデフォルト言語（英語）
- **Display Language**: VS Codeで現在設定されている表示言語

## Requirements

### Requirement 1

**User Story:** 拡張機能の利用者として、自分の使用言語（日本語または英語）でUIメッセージが表示されることを望む。これにより、母国語で拡張機能を快適に使用できる。

#### Acceptance Criteria

1. WHEN the Extension starts THEN the Extension SHALL detect the Display Language from VS Code's environment
2. WHEN the Display Language is Japanese ("ja") THEN the Extension SHALL load and display all UI messages in Japanese
3. WHEN the Display Language is English ("en") THEN the Extension SHALL load and display all UI messages in English
4. WHEN the Display Language is neither Japanese nor English THEN the Extension SHALL load and display all UI messages in the Fallback Language (English)
5. WHERE a Language Pack is installed THEN the Extension SHALL automatically use the corresponding language without requiring manual configuration

### Requirement 2

**User Story:** 開発者として、新しいUIメッセージを追加する際に、すべての対応言語で翻訳を提供できる構造を望む。これにより、一貫した多言語サポートを維持できる。

#### Acceptance Criteria

1. WHEN a developer adds a new UI message THEN the Extension SHALL provide a centralized location for defining message keys and translations
2. WHEN a message key is defined THEN the Extension SHALL require translations for all supported languages (Japanese and English)
3. WHEN a message contains dynamic content (e.g., proxy URLs, mode names) THEN the Extension SHALL support parameter substitution in translated messages
4. WHEN a translation is missing for a specific language THEN the Extension SHALL fall back to the Fallback Language translation for that message key
5. THE Extension SHALL organize Message Bundles by language code (e.g., "ja.json", "en.json")

### Requirement 3

**User Story:** 拡張機能の利用者として、すべてのユーザー向けメッセージ（情報、警告、エラー）が自分の言語で表示されることを望む。これにより、問題のトラブルシューティングや機能の理解が容易になる。

#### Acceptance Criteria

1. WHEN the Extension displays an information message THEN the Extension SHALL show the message in the user's detected language
2. WHEN the Extension displays a warning message THEN the Extension SHALL show the message in the user's detected language
3. WHEN the Extension displays an error message THEN the Extension SHALL show the message in the user's detected language
4. WHEN the Extension displays a success message THEN the Extension SHALL show the message in the user's detected language
5. WHEN the Extension displays action button labels THEN the Extension SHALL show the labels in the user's detected language

### Requirement 4

**User Story:** 拡張機能の利用者として、ステータスバーに表示されるテキストが自分の言語で表示されることを望む。これにより、現在のプロキシ状態を一目で理解できる。

#### Acceptance Criteria

1. WHEN the Extension updates the status bar THEN the Extension SHALL display the proxy mode label in the user's detected language
2. WHEN the proxy is in "Off" mode THEN the Extension SHALL display "Proxy: Off" (or Japanese equivalent) in the status bar
3. WHEN the proxy is in "Manual" mode THEN the Extension SHALL display "Proxy: Manual" (or Japanese equivalent) with the proxy URL in the status bar
4. WHEN the proxy is in "Auto" mode THEN the Extension SHALL display "Proxy: Auto" (or Japanese equivalent) with the proxy URL in the status bar
5. WHEN the status bar tooltip is shown THEN the Extension SHALL display the tooltip text in the user's detected language

### Requirement 5

**User Story:** 拡張機能の利用者として、コマンドパレットのコマンドタイトルが自分の言語で表示されることを望む。これにより、コマンドを見つけやすくなる。

#### Acceptance Criteria

1. WHEN the user opens the command palette THEN the Extension SHALL display command titles in the user's detected language
2. THE Extension SHALL localize the "Toggle Proxy" command title
3. THE Extension SHALL localize the "Test Proxy" command title
4. THE Extension SHALL localize the "Import System Proxy" command title
5. WHEN the Display Language changes THEN the Extension SHALL update command titles accordingly after reload

### Requirement 6

**User Story:** 拡張機能の利用者として、設定項目の説明が自分の言語で表示されることを望む。これにより、各設定の意味を正確に理解できる。

#### Acceptance Criteria

1. WHEN the user views extension settings THEN the Extension SHALL display setting descriptions in the user's detected language
2. THE Extension SHALL localize the description for "otakProxy.proxyUrl" setting
3. THE Extension SHALL localize the description for "otakProxy.pollingInterval" setting
4. THE Extension SHALL localize the description for "otakProxy.detectionSourcePriority" setting
5. THE Extension SHALL localize the description for "otakProxy.maxRetries" setting

### Requirement 7

**User Story:** 開発者として、翻訳の品質を検証し、欠落している翻訳を特定できる仕組みを望む。これにより、すべてのメッセージが適切に翻訳されていることを保証できる。

#### Acceptance Criteria

1. WHEN a message key is used in the code THEN the Extension SHALL log a warning if the translation is missing for any supported language
2. WHEN the Extension loads Message Bundles THEN the Extension SHALL validate that all message keys exist in all language files
3. WHEN a translation file has a syntax error THEN the Extension SHALL log an error and fall back to the Fallback Language
4. THE Extension SHALL provide a mechanism to list all message keys used in the codebase
5. THE Extension SHALL provide a mechanism to identify untranslated message keys
