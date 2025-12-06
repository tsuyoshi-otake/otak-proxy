<p align="center">
  <h1 align="center">otak-proxy</h1>
  <p align="center">Dead-simple proxy toggling for VSCode & Git</p>
</p>

---

Switch your proxy on and off with a single click. No hassle, no config files.

![](images/otak-proxy.png)

## What it does

- **Three-mode system** - Auto (system), Manual, or Off
- **Auto mode** - Syncs with your system/browser proxy in real-time with smart monitoring
- **Manual mode** - Use your own fixed proxy settings
- **One-click cycling** - Click status bar to cycle: Off → Manual → Auto
- **Live monitoring** - Auto mode checks for system proxy changes with configurable intervals and retry logic
- **Connection testing** - Verify proxy works before enabling
- **Smart detection** - Finds proxy from browser, system, or environment with customizable priority
- **npm support** - Automatically configures npm proxy settings alongside VSCode and Git
- **Secure validation** - Protects against command injection with strict input validation
- **Multi-language UI** - Automatically displays in English or Japanese based on your VSCode language

## Getting started

### Quick setup
The extension asks how you want to configure proxy on first launch:
- **Auto (System)** - Automatically uses your browser/system proxy
- **Manual Setup** - Set your own proxy URL
- **Skip** - Configure later

### Three modes explained

#### Off Mode
Proxy disabled - no proxy settings applied

#### Manual Mode
Uses your configured proxy URL - stays fixed until you change it

#### Auto Mode
Automatically syncs with system proxy:
- Detects browser/system proxy settings
- Configurable polling interval (10-300 seconds, default 30 seconds)
- Checks immediately when switching back to VSCode
- Automatic retry with exponential backoff on detection failures
- Detailed logging of proxy changes and detection sources
- Perfect for network switching scenarios

### Using it
- **Click status bar** - Cycles through Off → Manual → Auto
- **Command palette** (`F1`):
  - "Toggle Proxy" - Cycle modes
  - "Test Proxy" - Test current proxy
  - "Import System Proxy" - Detect and use system proxy
  - "Configure Manual" - Set manual proxy URL

## Status indicators

- **$(circle-slash) Proxy: Off** - Proxy disabled
- **$(plug) Manual: http://...** - Using manual proxy
- **$(sync~spin) Auto: http://...** - Using system proxy (auto-sync)
- **$(sync~spin) Auto: No system proxy** - Auto mode, but no system proxy detected

## Prerequisites

- VSCode 1.9.0+
- Git installed and in PATH

## Language Support

The extension automatically detects your VS Code display language and shows messages in:
- **English** (default)
- **Japanese** (日本語)

Language is detected from your VS Code Language Pack. No configuration needed - it just works!

## Architecture

The extension follows a modular architecture for maintainability and testability. After a comprehensive refactoring, the codebase has been reorganized from a single 1335-line file into focused, testable modules.

### Refactoring Results

- **Before**: extension.ts (1335 lines)
- **After**: extension.ts (160 lines, 88% reduction)
- **Total modules**: 30+ focused files
- **Test coverage**: 389 passing tests (unit + property-based)
- **All files**: Under 300 lines each

### Folder Structure

```
src/
├── extension.ts          # Entry point (160 lines)
│
├── core/                 # Core business logic
│   ├── types.ts         # Shared type definitions (ProxyMode, ProxyState, CommandContext)
│   ├── ProxyStateManager.ts    # State persistence with in-memory fallback
│   ├── ProxyApplier.ts         # Proxy configuration orchestration
│   └── ExtensionInitializer.ts # Initialization and setup logic
│
├── commands/            # Command implementations
│   ├── types.ts         # Command-specific types
│   ├── CommandRegistry.ts      # Centralized command registration
│   ├── ToggleProxyCommand.ts   # Toggle between Off/Manual/Auto modes
│   ├── ConfigureUrlCommand.ts  # Manual proxy URL configuration
│   ├── TestProxyCommand.ts     # Proxy connection testing
│   ├── ImportProxyCommand.ts   # System proxy detection and import
│   └── index.ts         # Module exports
│
├── ui/                  # User interface
│   └── StatusBarManager.ts     # Status bar management with i18n support
│
├── config/              # Configuration managers
│   ├── GitConfigManager.ts     # Git global proxy configuration
│   ├── VscodeConfigManager.ts  # VSCode workspace proxy settings
│   ├── NpmConfigManager.ts     # npm proxy configuration
│   └── SystemProxyDetector.ts  # Multi-platform system proxy detection
│
├── monitoring/          # Proxy monitoring (Auto mode)
│   ├── ProxyMonitor.ts         # Polling-based proxy change detection
│   ├── ProxyMonitorState.ts    # Monitor state management
│   └── ProxyChangeLogger.ts    # Proxy change event logging
│
├── validation/          # Input validation and security
│   ├── ProxyUrlValidator.ts    # URL format and security validation
│   └── InputSanitizer.ts       # Command injection prevention
│
├── errors/              # Error handling
│   ├── ErrorAggregator.ts      # Multi-source error collection
│   └── UserNotifier.ts         # User-facing error notifications
│
├── i18n/                # Internationalization
│   ├── types.ts         # i18n type definitions
│   ├── I18nManager.ts          # Translation manager (singleton)
│   └── locales/                # Translation files (en, ja)
│       ├── en.json
│       └── ja.json
│
├── models/              # Data models
│   └── ProxyUrl.ts             # Proxy URL parsing and validation
│
├── utils/               # Shared utilities
│   ├── Logger.ts               # Centralized logging
│   └── ProxyUtils.ts           # Proxy-related utility functions
│
└── test/                # Test suites
    ├── *.test.ts               # Unit tests
    ├── *.property.test.ts      # Property-based tests (fast-check)
    ├── generators.ts           # Test data generators
    └── helpers.ts              # Test utilities
```

### Key Design Principles

1. **Single Responsibility**: Each module handles one specific concern
   - Commands are isolated in separate files
   - State management is centralized in ProxyStateManager
   - Configuration logic is separated by target (Git, VSCode, npm)

2. **Dependency Injection**: Components receive dependencies through constructors
   - Enables easy testing with mocks
   - Clear dependency graph
   - No hidden global state

3. **Error Aggregation**: Multiple configuration errors are collected and displayed together
   - ErrorAggregator collects errors from Git, VSCode, and npm
   - UserNotifier presents consolidated error messages
   - Users see all issues at once, not one at a time

4. **State Management**: Centralized state with automatic fallback
   - ProxyStateManager handles all state operations
   - Automatic in-memory fallback if globalState fails
   - Transparent migration from legacy state formats

5. **Command Pattern**: Commands are isolated and independently testable
   - Each command is a pure function receiving CommandContext
   - CommandRegistry centralizes registration logic
   - Easy to add new commands without modifying existing code

6. **Property-Based Testing**: Core logic is verified with property-based tests
   - 15+ property-based tests using fast-check
   - Tests verify universal properties across random inputs
   - Complements unit tests for comprehensive coverage

### Component Interactions

```
┌─────────────────────────────────────────────────────────────┐
│                      extension.ts                           │
│                    (Entry Point)                            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ├─→ ExtensionInitializer
                         │   └─→ Initial setup & migration
                         │
                         ├─→ CommandRegistry
                         │   ├─→ ToggleProxyCommand ──┐
                         │   ├─→ ConfigureUrlCommand ─┤
                         │   ├─→ TestProxyCommand ────┤
                         │   └─→ ImportProxyCommand ──┤
                         │                             │
                         │                             ↓
                         │                    ┌────────────────┐
                         │                    │ ProxyApplier   │
                         │                    └────────┬───────┘
                         │                             │
                         │                    ┌────────┴────────┐
                         │                    │                 │
                         │                    ↓                 ↓
                         │            GitConfigManager  VscodeConfigManager
                         │                    ↓
                         │            NpmConfigManager
                         │                    │
                         │                    ↓
                         │            ErrorAggregator
                         │
                         ├─→ ProxyStateManager
                         │   └─→ State persistence & migration
                         │
                         ├─→ StatusBarManager
                         │   └─→ UI updates with i18n
                         │
                         └─→ ProxyMonitor (Auto Mode)
                             ├─→ SystemProxyDetector
                             └─→ ProxyChangeLogger
```

### Module Responsibilities

#### Core Modules

- **extension.ts**: Minimal entry point that orchestrates initialization and command registration
- **ExtensionInitializer**: Handles first-run setup, state migration, and component initialization
- **ProxyStateManager**: Manages ProxyState persistence with automatic fallback and migration
- **ProxyApplier**: Orchestrates proxy configuration across Git, VSCode, and npm

#### Command Modules

- **CommandRegistry**: Centralizes all command registration and event listener setup
- **ToggleProxyCommand**: Cycles through Off → Manual → Auto modes
- **ConfigureUrlCommand**: Prompts user for manual proxy URL
- **TestProxyCommand**: Tests proxy connectivity before enabling
- **ImportProxyCommand**: Detects and imports system proxy settings

#### Configuration Modules

- **GitConfigManager**: Manages `git config --global http.proxy`
- **VscodeConfigManager**: Manages VSCode workspace proxy settings
- **NpmConfigManager**: Manages npm proxy configuration
- **SystemProxyDetector**: Multi-platform system proxy detection (Windows/macOS/Linux)

#### UI & Monitoring

- **StatusBarManager**: Updates status bar text, tooltip, and icons based on current state
- **ProxyMonitor**: Polls for system proxy changes in Auto mode
- **ProxyChangeLogger**: Logs proxy change events for debugging

#### Validation & Error Handling

- **ProxyUrlValidator**: Validates proxy URL format and security
- **InputSanitizer**: Prevents command injection attacks
- **ErrorAggregator**: Collects errors from multiple sources
- **UserNotifier**: Displays user-friendly error messages with suggestions

### Testing Strategy

The extension uses a dual testing approach:

1. **Unit Tests**: Verify specific examples and edge cases
   - 200+ unit tests covering individual functions
   - Mock external dependencies (Git, npm commands)
   - Fast execution for rapid feedback

2. **Property-Based Tests**: Verify universal properties
   - 15+ property-based tests using fast-check
   - Generate random inputs to find edge cases
   - Validate correctness properties from design document
   - Examples:
     - State persistence fallback works for any state
     - Command error handling is consistent across all commands
     - Status bar reflects any ProxyState accurately

3. **Integration Tests**: Verify end-to-end workflows
   - Test complete command execution flows
   - Verify component interactions
   - Use real Git/npm commands where necessary

**Test Performance**:
- Development mode: ~30 seconds (reduced iterations)
- CI mode: ~2 minutes (full iterations)
- Parallel execution enabled
- 389 tests passing

## Configuration

### Manual proxy URL
Set your manual proxy in settings:
```json
{
  "otakProxy.proxyUrl": "http://proxy.example.com:8080"
}
```

### Auto mode settings
Customize auto mode behavior:
```json
{
  "otakProxy.pollingInterval": 30,
  "otakProxy.detectionSourcePriority": ["environment", "vscode", "platform"],
  "otakProxy.maxRetries": 3
}
```

- **pollingInterval**: How often to check for proxy changes (10-300 seconds)
- **detectionSourcePriority**: Order to check proxy sources
- **maxRetries**: Maximum retry attempts on detection failure

### Auto mode detection sources
Auto mode checks these sources (customizable order):
1. Environment variables (`HTTP_PROXY`, `HTTPS_PROXY`)
2. VSCode's existing proxy setting
3. **Windows**: Internet Explorer settings (registry)
4. **macOS**: System network preferences (Wi-Fi, Ethernet, etc.)
5. **Linux**: GNOME proxy settings (gsettings)

## Troubleshooting

### Proxy won't enable?
- Check the URL format (needs `http://` or `https://`)
- Run "Test Proxy" to verify connection
- Make sure Git is installed (`git --version`)
- Verify npm is installed if you need npm proxy support (`npm --version`)

### Settings not applying?
- VSCode might need a restart for some proxy changes
- Check you have permission to modify Git global config
- Verify npm configuration permissions if npm proxy fails

### Auto mode not detecting changes?
- Check the polling interval setting (default 30 seconds)
- Verify system proxy is properly configured
- Check extension output log for detection errors
- Try adjusting detection source priority

### Security and validation errors?
- Proxy URLs are validated for security (no shell metacharacters allowed)
- Credentials in URLs are automatically masked in logs and UI
- Invalid URLs are rejected before configuration

## More from otak

### System & Performance
- **[otak-monitor](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor)** - Live CPU, memory & disk monitoring in your status bar
- **[otak-restart](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart)** - Quick restart buttons for Extension Host and VSCode

### Productivity
- **[otak-committer](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer)** - AI-powered commit messages in 25+ languages
- **[otak-pomodoro](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro)** - Pomodoro timer for focused work sessions
- **[otak-clock](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock)** - Dual timezone clock for remote teams

### Workflow
- **[otak-zen](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen)** - Distraction-free coding mode

## License

MIT

---

**Issues?** [Report on GitHub](https://github.com/tsuyoshi-otake/otak-proxy/issues) | **Source:** [GitHub](https://github.com/tsuyoshi-otake/otak-proxy)