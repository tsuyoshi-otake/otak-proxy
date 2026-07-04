# Change Log

## [3.1.1] - 2026-07-05

### Fixed
- Read the WinHTTP proxy state from the locale-independent `WinHttpSettings` registry binary, so proxy diagnostics no longer fail to parse localized `netsh winhttp show proxy` output on non-English/Japanese Windows (#11).
- Run startup proxy enforcement off the activation critical path via a bounded background reconciliation loop, so a slow diagnostics pass can no longer delay extension activation (#12).
- Localize the `otak: Diagnose Proxy State` output: every notification and target/reason label now resolves through the 16 shipped locale files instead of hard-coded English (#13).
- Preserve every distinct proxy credential during the v2→v3 SecretStorage migration (previously only one survived when several authenticated proxy URLs existed), and warn when duplicates cannot be migrated (#14).
- Key flap-tracker fingerprints on stable proxy identity so rapidly changing proxy values can no longer bypass flap suppression and retry escalation (#15).
- Distinguish a Git config read failure (unparsable `.gitconfig` or missing `git`) from an unset key, so read failures are surfaced as informational instead of triggering retryable convergence mismatches that retries cannot fix (#16).
- Renew the apply-lock lease during long applies and shorten the locked critical section so concurrent windows contend for a shorter time.

### Changed
- The manual `otak: Diagnose Proxy State` command now always reads fresh state, bypassing the slow-diagnostics TTL cache (#16).
- WinINet diagnostics query only the four required registry values individually instead of dumping the entire Internet Settings key (#16).
- Run WinHTTP/WinINet diagnostics wherever the extension host is a Windows host, including Remote-SSH to Windows, not only the local UI host (#16).
- Clarify the diagnostic issue notification wording (#9).
- Remove dead internal API surface: unused `ProxyApplyTrigger` values and the unpopulated `TargetOwnership.previousUserValue` field (#16).

### Security
- Close credential redaction gaps found in the v3 review so authenticated URLs, authorization headers, and tokens are consistently masked in logs and diagnostics.
- Pin the v3 remediation safety settings to machine scope so synced or workspace configuration cannot weaken them.

## [3.0.0] - 2026-07-04

### Added
- Added the v3 diagnostics and safe remediation foundation with sanitized issue reports, execution-context detection, slow diagnostic TTL caching, and the `otak: Diagnose Proxy State` command.
- Added cross-window host/user apply locks plus bounded delayed retry and flap suppression so repeated external rewrites do not create infinite repair loops.
- Added credential-aware SecretStorage migration and local consent controls for authenticated proxy URLs that would be written to plaintext target config files.
- Added terminal environment masking options for proxy Off mode and Windows-aware terminal env handling.
- Added the user-approved `otak: Reset WinHTTP Proxy` command, gated by `otakProxy.windowsActionsEnabled`.

### Changed
- Routed startup, sync, Auto mode, and manual proxy application through the same safe apply path while preserving the existing `ProxyApplier.applyProxy()` boolean API.
- Expanded settings for diagnostics, remediation, notification level, flap thresholds, slow diagnostic TTL, credential target policy, Windows actions, and legacy Auto detection compatibility.

### Security
- Redaction now covers authenticated URLs, authorization headers, Basic auth payloads, npm tokens, Git extra headers, command output, copied diagnostics, control characters, and sync/diagnostic payloads.
- Synchronized/global state continues to store sanitized public proxy data only; local ownership and credential consent are machine-local.

## [2.3.2] - 2026-06-28

### Changed
- Replaced the marketplace icon with the new otak-proxy branding (dark badge with the proxy plug glyph), shipped at 48/128/256/512 px plus SVG

### Documentation
- Rewrote the README using the otak-paste layout: centered header with status badges, capability list, settings table, language support, and a Related Extensions table

## [2.3.1] - 2026-06-20

### Changed
- Bounded `NotificationThrottler` memory: the notification history is now capped (LRU eviction) so it no longer grows with session length when many distinct error messages are surfaced (O(N) retained entries → O(1))
- Skipped log argument sanitization when logging is silenced, avoiding unnecessary serialization/allocation on the hot path
- Avoided a redundant array copy in `ProxyChangeLogger` history getters

### Documentation
- Updated README to cover the `otak: Configure Manual Proxy` command, the automatic connection testing and multi-instance sync features, and the previously undocumented settings (`autoTestEnabled`, `testInterval`, `syncEnabled`, `syncInterval`, `detectionSourcePriority`, `maxRetries`)

## [2.3.0] - 2026-06-19

### Added
- UI language support for all G20 countries, adding 10 new locales (16 total): Spanish (`es`), Brazilian Portuguese (`pt-br`), French (`fr`), German (`de`), Hindi (`hi`), Indonesian (`id`), Italian (`it`), Russian (`ru`), Arabic (`ar`), and Turkish (`tr`). The UI language continues to follow the VS Code display language.

### Changed
- Locale resolution now maps any Portuguese variant (`pt`, `pt-pt`, `pt-br`) to the shipped Brazilian Portuguese translations
- `package.nls.*.json` files for the new locales are generated from `src/i18n/locales/*.json` via `npm run gen:nls`

## [2.2.17] - 2026-06-06

### Changed
- Removed dead `updateDetectionPriority` helper and stale `TestOptions` / `TestUrlError` re-exports from the proxy utility entrypoint; consumers were already using the SystemProxyDetector method or the source modules directly
- Added `knip.json` so dead-code detection reliably distinguishes real unused exports from test-only files

### Fixed
- Restored the missing `[2.2.6]` changelog entry from git history and slimmed the `[2.2.7]` entry back to its own two changes

## [2.2.16] - 2026-06-06

### Changed
- Refactored command, config, monitor, sync, UI, error, and extension modules into focused submodules with no user-visible behavior change

## [2.2.15] - 2026-06-06

### Added
- Added progress feedback while applying or clearing VS Code, Git, npm, and integrated terminal proxy settings

### Changed
- Localized aggregated configuration errors and troubleshooting suggestions

### Fixed
- Improved Git config lock handling with cross-window wait/retry feedback, stale lock cleanup, and throttled lock notifications

## [2.2.14] - 2026-06-05

### Changed
- Refactored extension initialization, proxy application, monitoring, sync, and proxy utility modules into focused submodules with no user-visible behavior change

## [2.2.13] - 2026-06-05

### Fixed
- Started multi-instance sync before applying local startup state so an existing shared state wins on launch
- Stopped clearing unrelated Git, VS Code, and npm proxy settings on startup when otak-proxy is Off
- Tested manual fallback proxies before using them in Auto mode and left Auto mode as `OFF` when fallback is unreachable
- Honored newly detected system proxy state when switching from Manual to Auto
- Sent `Proxy-Authorization` headers during proxy connection tests and treated non-2xx CONNECT responses as failures
- Rejected malformed URL-encoded proxy credentials during validation

## [2.2.12] - 2026-06-05

### Added
- Added `otak: Configure Manual Proxy` to the Command Palette and localized extension descriptions across package NLS files

### Changed
- Localized manual proxy prompts, validation errors, troubleshooting suggestions, system-proxy warnings, and proxy test result messages
- Showed warning messages as temporary status bar messages to reduce notification noise
- Refined Vietnamese UI translations

## [2.2.11] - 2026-06-05

### Changed
- Replaced sync file watching with stat polling for more reliable cross-instance changes
- Changed `otakProxy.proxyUrl` to machine scope and raised the minimum VS Code version to 1.97.0
- Hardened status bar and sync tooltips by writing dynamic values as text

### Fixed
- Stored proxy credentials only in secret storage or runtime state, while persisting sanitized URLs to settings, global state, sync files, and logs
- Scrubbed legacy persisted proxy credentials and compared manual proxy URL changes by public URL
- Blocked proxy apply and disable operations in untrusted workspaces
- Fixed HTTPS proxy connection tests by using protocol-specific transports and default ports

## [2.2.10] - 2026-04-25

### Changed
- Updated README copy to clarify Auto and Manual modes, integrated terminal environment behavior, and privacy handling

### Fixed
- Masked proxy passwords in status bar text, status bar tooltips, and fallback proxy notifications

## [2.2.9] - 2026-03-28

### Added
- Add `otakProxy.showProxyUrl` setting and `otak: Toggle Proxy URL Visibility` command to show/hide the proxy URL in the status bar for privacy (PR #7 by @yogwang)
  - When hidden, URLs are replaced with localized "Configured" text in both status bar and tooltip

### Fixed
- Deduplicate sync events to stop redundant "Proxy configured" notifications during multi-instance synchronization (PR #6 by @yogwang, closes #5)
  - Add version/state deduplication in SyncManager and ConflictResolver
  - Implement notification throttling in UserNotifier
  - Add silent mode for background sync and monitor-driven proxy transitions

## [2.2.8] - 2026-03-23

### Changed
- Add `otak:` prefix to all command titles for better discoverability in the Command Palette (PR #3 by @yogwang)
- Deduplicate and reorder i18n locale entries by scope
- Enrich config descriptions for `enableFallback`, `syncEnabled`, `syncInterval` across all locales

## [2.2.7] - 2026-02-17

### Changed
- All `otakProxy.*` settings are now excluded from VSCode Settings Sync: `proxyUrl`, `pollingInterval`, `maxRetries`, `testInterval`, `autoTestEnabled`, `enableFallback`, `syncInterval` → `machine-overridable` (workspace can still override); `detectionSourcePriority`, `syncEnabled` → `machine`

### Fixed
- TestProxy: consolidate failure notifications into a single message (previously two sequential error toasts appeared)

## [2.2.6] - 2026-02-17

### Changed
- Refactor: introduce `ErrorUtils` for type-safe error property access (`getErrorCode`, `getErrorMessage`, `getErrorStderr`, `getErrorSignal`, `wasProcessKilled`), replacing `error: any` casts across config managers and sync components
- Logger: respect `OTAK_PROXY_LOG_SILENT` env-var at the method level; improve type safety (`unknown` over `any`); sanitize error stack traces
- SyncManager: add periodic sync timer, `remoteChangeInProgress` guard to prevent concurrent remote/manual sync races, surface `instancesCleaned` in `SyncResult`
- Config managers (Git, npm, Terminal, VSCode, SystemProxyDetector): migrate to `ErrorUtils`; tighten TypeScript types

### Fixed
- ConflictResolver / SharedStateFile / FileWatcher: harden edge cases found during expanded property tests

## [2.2.5] - 2026-02-16

### Fixed
- Status bar not updating when receiving proxy state changes from another VSCode instance via multi-instance sync

## [2.2.4] - 2026-02-16

### Fixed
- Multi-instance sync: proxy state changes via commands (toggle, configure URL, import) were not propagated to other VSCode instances

## [2.2.3] - 2026-02-16

### Added
- UI i18n: Vietnamese (`vi`)

### Changed
- Unit tests: hermetic Git/npm config + improved parallel stability
- Sync conflict notification is now shown as a short-lived status bar message (auto-dismiss)

## [2.0.0] - 2024-12-06

### Added
- **Multi-language UI Support**
  - Automatic language detection (English and Japanese)
  - Localized messages, commands, and configuration descriptions
  - No configuration needed - uses VSCode Language Pack settings

- **npm Proxy Support**
  - Automatic npm proxy configuration alongside VSCode and Git
  - Configures both http-proxy and https-proxy for npm
  - Graceful error handling when npm is not installed

- **Enhanced Auto Mode**
  - Configurable polling interval (10-300 seconds, default 30)
  - Automatic retry with exponential backoff on detection failures
  - Customizable detection source priority
  - Detailed logging of proxy changes and detection sources
  - Immediate check when VSCode window gains focus

- **Security Enhancements**
  - Strict input validation to prevent command injection
  - Shell metacharacter detection and rejection
  - Credential masking in logs and UI
  - Secure command execution using execFile()

- **Improved Error Handling**
  - Detailed error messages with troubleshooting suggestions
  - Error aggregation across multiple configuration operations
  - Platform-specific error detection and handling
  - Graceful degradation when components fail

### Changed
- **Status Bar Improvements**
  - Command links are now always available after extension activation
  - Enhanced tooltip with last check time and detection source
  - Better error feedback in status bar

- **Configuration**
  - Added `otakProxy.pollingInterval` setting
  - Added `otakProxy.detectionSourcePriority` setting
  - Added `otakProxy.maxRetries` setting

### Fixed
- Command registration order to ensure all commands are available immediately
- Proxy detection reliability with retry logic
- Error handling for partial configuration failures

## [1.5.0] - 2024-03-01

### Changed
- Repackaged the extension for version 1.5.0

## [1.3.3] - 2024-02-21

### Changed
- Improved notification handling
  - Added auto-closing notifications for error messages (7 seconds)
  - Enhanced proxy URL configuration prompts with dismissible notifications

## [1.3.2] - 2024-02-20

### Changed
- Updated dependencies for better stability
- Improved code quality

## [1.3.1] - 2024-02-20

### Changed
- Repackaged extension for better stability

## [1.3.0] - 2024-02-20

### Changed
- Improved status bar tooltip interface
  - Added clickable action buttons in tooltip
  - Simplified status display format
  - Enhanced tooltip layout and usability
- Removed unnecessary notifications for proxy state changes

## [1.2.2] - 2024-02-18

### Changed
- Cancelled the implementation of multi-language support
- Focus on maintaining stable core functionality

## [1.1.3] - 2024-02-18

### Changed
- Removed OS system proxy configuration feature
- Simplified proxy management to focus on VSCode and Git settings only
- Removed admin privilege requirement

## [1.1.2] - 2024-02-17

### Changed
- Updated extension icon for better visibility

## [1.1.1] - 2024-02-17

### Fixed
- Git proxy disabling error handling
  - Added existence check for Git proxy settings
  - Improved error handling when removing non-existent proxy settings

## [1.1.0] - 2024-02-17

### Added
- One-click proxy configuration for:
  - OS system proxy settings (Windows WinHTTP, macOS Network Services, Linux GNOME)
  - VSCode proxy settings
  - Git proxy configuration
- Status bar toggle button
- Multi-OS support
- Error handling with detailed messages
- Independent error handling for each component

### Changed
- Removed GitHub CLI specific configuration
- Simplified proxy management focusing on system proxy

### Notes
- Requires admin privileges for system proxy
- Settings are applied immediately

## [1.0.0] - 2024-02-16

### Added
- Initial release
- VSCode proxy configuration
- Git proxy configuration
- GitHub CLI proxy configuration
- Basic error handling

## [0.0.1] - 2024-02-16

### Added
- Initial release of Otak Proxy Extension for VSCode
- Toggle proxy settings for VSCode, Git and GitHub CLI with one click
- Clear status bar indicators
- Simple and efficient proxy configuration management
- Automatic synchronization across all tools
