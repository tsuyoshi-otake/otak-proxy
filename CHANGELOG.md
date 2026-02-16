# Change Log

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
