# otak-proxy Architecture Document

## Overview

This document describes the architecture and design decisions of the otak-proxy extension in detail.

## Refactoring Background

### Problems (Before Refactoring)

- **Bloated single file**: extension.ts reached 1335 lines, making maintenance difficult
- **Mixed responsibilities**: Commands, state management, UI updates, and configuration application were all in one file
- **Code duplication**: Particularly within the importProxy command, similar logic was repeated 3 times
- **Slow tests**: Heavy dependence on external commands, high property-based test iteration counts

### Improvements (After Refactoring)

- **File size**: extension.ts from 1335 lines to ~350 lines (74% reduction)
- **Module count**: 40+ focused modules
- **Test coverage**: 1,000+ test cases (unit + property-based + integration), 74 test files
- **Circular dependencies**: None (verified with madge)

## Folder Structure

```
src/
├── extension.ts          # Entry point (~350 lines)
│
├── core/                 # Core business logic
│   ├── types.ts         # Common type definitions (ProxyMode: Off/Manual/Auto)
│   ├── ProxyStateManager.ts    # State persistence
│   ├── ProxyApplier.ts         # Proxy configuration orchestration
│   └── ExtensionInitializer.ts # Initialization logic
│
├── commands/            # Command implementations
│   ├── types.ts         # Command-specific types
│   ├── CommandRegistry.ts      # Centralized command registration
│   ├── ToggleProxyCommand.ts   # Mode switching
│   ├── ConfigureUrlCommand.ts  # Manual proxy URL configuration
│   ├── TestProxyCommand.ts     # Proxy connection testing
│   ├── ImportProxyCommand.ts   # System proxy detection and import
│   └── index.ts         # Module exports
│
├── ui/                  # User interface
│   └── StatusBarManager.ts     # Status bar management
│
├── config/              # Configuration managers
│   ├── GitConfigManager.ts     # Git configuration (with cross-process mutex)
│   ├── VscodeConfigManager.ts  # VS Code configuration
│   ├── NpmConfigManager.ts     # npm configuration (platform-aware)
│   ├── TerminalEnvConfigManager.ts  # Terminal environment variable management
│   └── SystemProxyDetector.ts  # System proxy detection
│
├── monitoring/          # Proxy monitoring (Auto mode)
│   ├── ProxyMonitor.ts         # Polling-based change detection (EventEmitter)
│   ├── ProxyMonitorState.ts    # Monitor state management
│   ├── ProxyChangeLogger.ts    # Change event logging
│   ├── ProxyConnectionTester.ts # Proxy connection testing (Auto/Manual modes)
│   ├── ProxyFallbackManager.ts  # Fallback proxy selection
│   └── ProxyTestScheduler.ts    # Periodic connection test scheduler
│
├── sync/                # Multi-instance synchronization
│   ├── SyncManager.ts          # Sync orchestrator
│   ├── InstanceRegistry.ts     # Instance registration and lifecycle management
│   ├── SharedStateFile.ts      # Shared state file (atomic read/write)
│   ├── FileWatcher.ts          # File change monitoring (with debounce)
│   ├── ConflictResolver.ts     # Timestamp-based conflict resolution
│   ├── SyncConfigManager.ts    # Sync configuration management
│   ├── SyncStatusProvider.ts   # Status bar sync state display
│   └── index.ts         # Module exports
│
├── validation/          # Input validation and security
│   ├── ProxyUrlValidator.ts    # URL validation
│   └── InputSanitizer.ts       # Command injection prevention
│
├── errors/              # Error handling
│   ├── ErrorAggregator.ts      # Error collection from multiple sources
│   ├── UserNotifier.ts         # User-facing error notifications (with throttling)
│   ├── NotificationFormatter.ts # Notification message formatting
│   ├── NotificationThrottler.ts # Duplicate notification suppression
│   ├── OutputChannelManager.ts  # Output channel log management (singleton)
│   └── StateChangeDebouncer.ts  # State change debouncing
│
├── i18n/                # Internationalization
│   ├── types.ts         # i18n type definitions
│   ├── I18nManager.ts          # Translation manager (singleton)
│   └── locales/                # Translation files
│       ├── en.json             # English
│       ├── ja.json             # Japanese
│       ├── ko.json             # Korean
│       ├── vi.json             # Vietnamese
│       ├── zh-cn.json          # Simplified Chinese
│       └── zh-tw.json          # Traditional Chinese
│
├── models/              # Data models
│   └── ProxyUrl.ts             # Proxy URL parsing and validation
│
├── utils/               # Shared utilities
│   ├── Logger.ts               # Centralized logging (auto credential masking)
│   ├── ProxyUtils.ts           # Proxy-related utilities
│   └── ErrorUtils.ts           # Type-safe error property extraction
│
└── test/                # Test suite
    ├── *.test.ts               # Unit tests
    ├── *.property.test.ts      # Property-based tests
    ├── *.integration.test.ts   # Integration tests
    ├── generators.ts           # Test data generators
    ├── helpers.ts              # Test utilities
    ├── commands/               # Command tests
    ├── core/                   # Core module tests
    ├── errors/                 # Error handling tests
    ├── i18n/                   # Internationalization tests
    ├── integration/            # Integration tests
    ├── monitoring/             # Monitoring module tests
    ├── settings/               # Settings tests
    ├── sync/                   # Sync module tests
    ├── ui/                     # UI tests
    └── utils/                  # Utility tests
```

## Design Principles

### 1. Single Responsibility Principle

Each module has one clear responsibility:

- **ProxyStateManager**: Responsible only for state persistence
- **ProxyApplier**: Responsible only for proxy configuration application
- **StatusBarManager**: Responsible only for UI updates
- **Each Command**: Responsible only for executing one command
- **SyncManager**: Responsible only for coordinating multi-instance synchronization

### 2. Dependency Injection

Components receive dependencies through their constructors:

```typescript
export class ProxyApplier {
    constructor(
        private gitManager: GitConfigManager,
        private vscodeManager: VscodeConfigManager,
        private npmManager: NpmConfigManager,
        private validator: ProxyUrlValidator,
        private sanitizer: InputSanitizer,
        private userNotifier: UserNotifier,
        private stateManager?: ProxyStateManager,
        private terminalEnvManager?: TerminalEnvConfigManager
    ) {}
}
```

**Benefits**:
- Easy to inject mocks during testing
- Clear dependency graph
- No hidden global state

### 3. Error Aggregation

Collects multiple configuration errors and displays them at once:

```typescript
const errorAggregator = new ErrorAggregator();

// Attempt Git, VS Code, npm, and terminal configuration
await this.updateManager(this.gitManager, 'Git', enabled, proxyUrl, errorAggregator);
await this.updateManager(this.vscodeManager, 'VSCode', enabled, proxyUrl, errorAggregator);
await this.updateManager(this.npmManager, 'npm', enabled, proxyUrl, errorAggregator);

// Display all errors at once
if (errorAggregator.hasErrors()) {
    this.userNotifier.showAggregatedErrors(errorAggregator);
}
```

**Benefits**:
- Users can see all issues at once
- No need to fix errors one at a time

### 4. Centralized State Management

ProxyStateManager manages all state operations:

```typescript
export class ProxyStateManager {
    private inMemoryState: ProxyState | null = null;

    async getState(): Promise<ProxyState> {
        // Read from globalState, fall back to in-memory on failure
    }

    async saveState(state: ProxyState): Promise<void> {
        // Save to globalState, fall back to in-memory on failure
    }
}
```

**Benefits**:
- Consistent state read/write
- Automatic fallback mechanism
- Transparent migration from legacy settings

### 5. Command Pattern

Each command receives a CommandContext as a pure function:

```typescript
export async function executeToggleProxy(ctx: CommandContext): Promise<void> {
    const currentState = await ctx.stateManager.getState();
    // Command logic
}
```

**Benefits**:
- New commands can be added without modifying existing code
- Easy to test
- Independence between commands is guaranteed

### 6. Property-Based Testing

Core logic is verified using fast-check:

```typescript
it('Property 3: State persistence fallback', () => {
    fc.assert(
        fc.asyncProperty(
            fc.record({
                mode: fc.constantFrom('off', 'manual', 'auto'),
                manualProxyUrl: fc.option(fc.webUrl()),
                // ...
            }),
            async (state) => {
                // Verify in-memory fallback works even when globalState.update fails
            }
        ),
        { numRuns: 100 }
    );
});
```

**Benefits**:
- Discovers edge cases with random inputs
- Complements unit tests for comprehensive coverage

### 7. Event-Driven Architecture

ProxyMonitor and SyncManager leverage EventEmitter for loose coupling:

```typescript
// Events emitted by ProxyMonitor
proxyMonitor.on('proxyChanged', (result) => { /* Apply new proxy */ });
proxyMonitor.on('proxyTestComplete', (result) => { /* Process test result */ });
proxyMonitor.on('proxyStateChanged', (reachable) => { /* Update UI */ });

// Events emitted by SyncManager
syncManager.on('remoteChange', (state) => { /* Apply remote change */ });
syncManager.on('conflictResolved', (resolution) => { /* Handle conflict resolution */ });
syncManager.on('syncStateChanged', (status) => { /* Update sync state */ });
```

**Benefits**:
- Loose coupling between components
- Easy to add new event listeners
- Events can be individually verified during testing

## Component Interactions

### Startup Flow

```
1. extension.ts activate()
   ↓
2. I18nManager initialization
   ↓
3. Core component creation
   ├─→ Validator, Sanitizer, ConfigManagers
   ├─→ ProxyStateManager, ProxyApplier
   └─→ ExtensionInitializer
   ↓
4. ProxyMonitor initialization
   ↓
5. SyncManager initialization (optional, falls back to standalone mode on failure)
   ├─→ InstanceRegistry (instance registration)
   ├─→ FileWatcher (shared state file monitoring)
   ├─→ ConflictResolver
   └─→ Event listener setup (remoteChange, conflictResolved, etc.)
   ↓
6. StatusBarManager initialization
   ↓
7. CommandRegistry.registerAll()
   ├─→ Command registration
   ├─→ Configuration change listeners
   └─→ Window focus listeners
   ↓
8. Initial UI display / setup dialog
   ↓
9. Apply current proxy settings / start monitoring
```

### Command Execution Flow (e.g., Toggle Proxy)

```
1. User clicks the status bar
   ↓
2. ToggleProxyCommand.executeToggleProxy()
   ↓
3. ProxyStateManager.getState()
   └─→ Retrieve current state
   ↓
4. Determine next mode (Off → Manual → Auto)
   ↓
5. ProxyApplier.applyProxy() or disableProxy()
   ├─→ GitConfigManager
   ├─→ VscodeConfigManager
   ├─→ NpmConfigManager
   └─→ TerminalEnvConfigManager
   ↓
6. ProxyStateManager.saveState()
   └─→ Save new state
   ↓
7. SyncManager (when enabled)
   └─→ Propagate state to other instances
   ↓
8. StatusBarManager.update()
   └─→ Update UI
   ↓
9. UserNotifier.showSuccess()
   └─→ Success notification
```

### Auto Mode Monitoring Flow

```
1. ProxyMonitor.start()
   ↓
2. Periodic polling (default 30 seconds)
   ↓
3. SystemProxyDetector.detectSystemProxyWithSource()
   ├─→ Environment variable check
   ├─→ VS Code configuration check
   └─→ Platform-specific detection
   ↓
4. Proxy change detected
   ↓
5. ProxyChangeLogger.logChange()
   └─→ Log the change
   ↓
6. ProxyConnectionTester.testProxyAuto() (when connection testing is enabled)
   ├─→ Success: ProxyApplier.applyProxy()
   └─→ Failure: ProxyFallbackManager.selectBestProxy()
         ├─→ Apply fallback proxy if available
         └─→ Otherwise use direct connection
   ↓
7. StatusBarManager.update()
   └─→ Update UI
```

### Multi-Instance Sync Flow

```
1. Instance A: Changes proxy settings
   ↓
2. SyncManager.propagateState()
   └─→ Write to SharedStateFile (atomic write-then-rename)
   ↓
3. Instance B: FileWatcher detects file change
   ↓
4. SyncManager.reconcileWithSharedFile()
   ├─→ Compare local state with remote state
   └─→ Resolve conflicts via ConflictResolver (timestamp-based, latest wins)
   ↓
5. Instance B: Apply remote change
   ├─→ ProxyApplier.applyProxy()
   └─→ StatusBarManager.update()
```

## Module Details

### Core Modules

#### extension.ts
- **Responsibility**: Entry point, 12-phase initialization orchestration
- **Lines**: ~350
- **Key features**:
  - `activate()`: Extension initialization (12 phases)
  - `deactivate()`: SyncManager shutdown, resource disposal, monitoring stop
  - Event listener setup (sync events, configuration changes)

#### ExtensionInitializer
- **Responsibility**: First-launch processing, state migration, component initialization
- **Key features**:
  - First-launch detection and setup dialog
  - Migration from legacy settings
  - Auto mode monitoring startup

#### ProxyStateManager
- **Responsibility**: ProxyState persistence and retrieval
- **Key features**:
  - `getState()`: State loading (with automatic fallback)
  - `saveState()`: State saving (with automatic fallback)
  - `migrateOldSettings()`: Migration from legacy settings
- **Tests**: ProxyStateManager.test.ts, ProxyStateManager.property.test.ts

#### ProxyApplier
- **Responsibility**: Proxy configuration application orchestration
- **Key features**:
  - `applyProxy()`: Enable proxy (Git, VS Code, npm, terminal environment variables)
  - `disableProxy()`: Disable proxy
  - Error aggregation and user notification
- **Tests**: ProxyApplier.test.ts, ProxyApplier.property.test.ts

### Command Modules

#### CommandRegistry
- **Responsibility**: Registration of all commands and event listeners
- **Key features**:
  - `registerAll()`: Register all commands
  - Configuration change listeners
  - Window focus listeners

#### ToggleProxyCommand
- **Responsibility**: Mode switching (Off → Manual → Auto)
- **Flow**:
  1. Get current mode
  2. Determine next mode
  3. Apply or disable proxy
  4. Save state
  5. Update UI

#### ConfigureUrlCommand
- **Responsibility**: Manual proxy URL configuration
- **Flow**:
  1. Prompt user for URL input
  2. Validate URL
  3. Switch to Manual mode
  4. Apply proxy

#### TestProxyCommand
- **Responsibility**: Proxy connection testing
- **Flow**:
  1. Get current proxy URL
  2. Execute test connection
  3. Notify user of results

#### ImportProxyCommand
- **Responsibility**: System proxy detection and import
- **Flow**:
  1. Detect system proxy
  2. Let user choose an action (Auto/Manual/Test)
  3. Apply proxy based on selection

#### ToggleShowProxyUrlCommand
- **Responsibility**: Toggling the visibility of the proxy URL in the status bar
- **Flow**:
  1. Toggle `otakProxy.showProxyUrl` configuration in workspace settings
  2. Update UI (StatusBarManager reflects the hidden/shown state)

**Refactoring note**: Previously, similar logic was repeated 3 times; now consolidated into `handleUserAction()` and `applyProxyMode()`.

### Configuration Modules

#### GitConfigManager
- **Responsibility**: Managing `git config --global http.proxy`
- **Key features**:
  - `setProxy()`: Set http.proxy and https.proxy
  - `unsetProxy()`: Remove Git proxy settings
  - `getProxy()`: Get current Git proxy
- **Features**: Cross-process mutex (5s timeout, 30s stale detection), retry logic (5 attempts, exponential backoff)

#### VscodeConfigManager
- **Responsibility**: Managing VS Code global http.proxy setting
- **Key features**:
  - `setProxy()`: Set VS Code proxy
  - `unsetProxy()`: Remove VS Code proxy
  - `getProxy()`: Get current VS Code proxy

#### NpmConfigManager
- **Responsibility**: Managing npm proxy configuration
- **Key features**:
  - `setProxy()`: Set npm proxy (proxy, https-proxy)
  - `unsetProxy()`: Remove npm proxy
  - `getProxy()`: Get current npm proxy
- **Features**: Windows support (via `cmd.exe /d /s /c`), environment variable sanitization

#### TerminalEnvConfigManager
- **Responsibility**: Injecting proxy environment variables into VS Code integrated terminals
- **Key features**:
  - `setProxy()`: Set HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy
  - `unsetProxy()`: Remove all proxy environment variables
- **Features**: Flexible interface via duck-typing, graceful degradation when unavailable

#### SystemProxyDetector
- **Responsibility**: Multi-platform system proxy detection
- **Detection sources** (in priority order):
  - Environment variables (HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy)
  - Existing VS Code proxy settings
  - **Windows**: Internet Explorer registry settings
  - **macOS**: System network settings (Wi-Fi, Ethernet, Thunderbolt Ethernet)
  - **Linux**: GNOME proxy settings (gsettings)
- **Features**: Detection source tracking, configurable priority, URL validation

### Monitoring Modules

#### ProxyMonitor
- **Responsibility**: Proxy change monitoring in Auto mode (extends EventEmitter)
- **Key features**:
  - `start()`: Start polling
  - `stop()`: Stop polling
  - `triggerCheck()`: Debounced check trigger
  - `updateConfig()`: Dynamic configuration update
- **Events**: `proxyChanged`, `proxyTestComplete`, `proxyStateChanged`, `checkComplete`, `allRetriesFailed`
- **Default config**: 30s polling, 1s debounce, 3 retries, connection testing enabled (60s interval)

#### ProxyMonitorState
- **Responsibility**: Immutable holder for monitoring state
- **Key features**:
  - `recordCheckSuccess()`: Record success, reset failure count
  - `recordCheckFailure()`: Increment failure count
  - `getStatus()`: Return defensive copy

#### ProxyChangeLogger
- **Responsibility**: Logging proxy change, test, and fallback events
- **Key features**:
  - `logChange()`: Log proxy changes (with credential masking)
  - `logCheck()`: Log test attempts
  - `logFallbackToManual()`: Log fallback usage
  - 3 parallel history arrays (max 100 entries each)

#### ProxyConnectionTester
- **Responsibility**: Proxy connection testing (both Auto and Manual modes)
- **Key features**:
  - `testProxyAuto()`: 3s timeout, parallel execution, brief notifications
  - `testProxyManual()`: 5s timeout, detailed notifications
  - Result caching

#### ProxyFallbackManager
- **Responsibility**: Selecting the best proxy (system → manual fallback → direct connection)
- **Key features**:
  - `selectBestProxy()`: Priority-based selection with connection testing
  - Fallback enable/disable toggle

#### ProxyTestScheduler
- **Responsibility**: Scheduling periodic proxy connection tests
- **Key features**:
  - `start()`: Start scheduler with callback
  - `updateInterval()`: Update test interval (30s–10min)
  - `triggerImmediateTest()`: Immediate test execution
  - Overlapping test prevention

### Sync Modules

#### SyncManager
- **Responsibility**: Multi-instance synchronization orchestrator
- **Key features**:
  - Instance lifecycle management
  - State change propagation
  - Remote change detection and application
  - Error handling
- **Features**: Heartbeat (10s), cleanup (30s), polling fallback

#### InstanceRegistry
- **Responsibility**: Active instance registration and lifecycle management
- **Key features**:
  - Instance registration/unregistration
  - Zombie process detection (30s heartbeat timeout)
  - Mutex-protected atomic file operations

#### SharedStateFile
- **Responsibility**: Atomic read/write of shared state JSON file
- **Key features**:
  - Atomic writes via write-then-rename pattern
  - Corrupted file recovery
  - Retry on Windows EPERM/EACCES errors

#### FileWatcher
- **Responsibility**: Shared state file change monitoring
- **Key features**:
  - File monitoring via `fs.watch` (100ms debounce)
  - Platform difference absorption
  - Graceful error handling for missing/deleted files

#### ConflictResolver
- **Responsibility**: Conflict resolution for simultaneous changes
- **Resolution strategy**:
  - Timestamp-based (latest wins)
  - Deterministic tiebreaker (remote wins on equal timestamps)
  - Clock drift protection (rejects timestamps >30s in the future)

#### SyncConfigManager
- **Responsibility**: Sync configuration management
- **Key features**:
  - `otakProxy.syncEnabled`: Enable/disable sync
  - `otakProxy.syncInterval`: Sync interval (100–5000ms, default 1000ms)
  - Real-time configuration change notifications

#### SyncStatusProvider
- **Responsibility**: Sync state display in the status bar
- **Key features**:
  - Icon display (sync, syncing-spin, sync-ignored, debug-disconnect)
  - Tooltip (instance count, last sync time)
  - Background color warning on errors

### Validation & Error Handling

#### ProxyUrlValidator
- **Responsibility**: Proxy URL format and security validation
- **Validation items**:
  - URL format (http:// or https:// only)
  - Hostname validity
  - Port number range
  - Security risks (command injection)

#### InputSanitizer
- **Responsibility**: Command injection attack prevention
- **Key features**:
  - Shell metacharacter detection
  - Dangerous string escaping
  - Credential masking in logs and UI

#### ErrorAggregator
- **Responsibility**: Error collection from multiple sources
- **Key features**:
  - `addError()`: Add an error
  - `hasErrors()`: Check for errors
  - `formatErrors()`: Get formatted error message
  - `clear()`: Clear errors
  - `generateSuggestions()`: Platform-specific troubleshooting suggestions

#### UserNotifier
- **Responsibility**: User-facing error notifications (with throttling and formatting)
- **Key features**:
  - `showError()`: Display error message (with throttling)
  - `showSuccess()`: Success notification (auto-close after 3s)
  - `showWarning()`: Warning notification (auto-close after 10s)
  - `showErrorWithDetails()`: Error with detailed log ("Show Details" button)
  - `showProgressNotification()`: Progress UI for long operations
  - i18n support (message keys or direct text)

#### NotificationFormatter
- **Responsibility**: Notification message formatting (with size constraints)
- **Key features**: Message truncation (200 chars), suggestion limit (3), URL limit (2)

#### NotificationThrottler
- **Responsibility**: Duplicate notification suppression
- **Key features**: Time-based throttling (default 5s), failure-pattern-based exponential backoff

#### OutputChannelManager
- **Responsibility**: Centralized VS Code output channel management (singleton)
- **Key features**: Error/info/warning logging, automatic credential masking

#### StateChangeDebouncer
- **Responsibility**: Proxy state change debouncing
- **Key features**: Per-URL debouncing (default 1s), pending change cancellation

### Internationalization

#### I18nManager
- **Responsibility**: Translation management (singleton)
- **Key features**:
  - `t()`: Get translation by key
  - `getCurrentLocale()`: Get current locale
  - Automatic detection from VS Code language pack
- **Supported languages**: English, Japanese, Korean, Vietnamese, Simplified Chinese, Traditional Chinese

## Testing Strategy

### Multi-Layer Test Approach

The extension uses three testing approaches:

#### 1. Unit Tests

- **Purpose**: Verify specific examples and edge cases
- **Characteristics**:
  - Test individual functions
  - Mock external dependencies (Git, npm commands)
  - Fast execution for quick feedback

**Example**:
```typescript
it('should toggle from off to manual', async () => {
    const state = { mode: ProxyMode.Off };
    const nextMode = stateManager.getNextMode(state.mode);
    expect(nextMode).toBe(ProxyMode.Manual);
});
```

#### 2. Property-Based Tests

- **Purpose**: Verify universal properties
- **Library**: fast-check
- **Characteristics**:
  - Generate random inputs to discover edge cases
  - Verify correctness properties from design documents

**Example**:
```typescript
it('Property 3: State persistence fallback', () => {
    fc.assert(
        fc.asyncProperty(
            arbitraryProxyState,
            async (state) => {
                // Verify in-memory fallback works even when globalState.update fails
                mockGlobalState.update.mockRejectedValue(new Error('Storage failed'));
                await stateManager.saveState(state);
                const retrieved = await stateManager.getState();
                expect(retrieved).toEqual(state);
            }
        ),
        { numRuns: 100 }
    );
});
```

**Verified properties**:
- Property 1: Command error handling consistency
- Property 2: Command independence
- Property 3: State persistence fallback
- Property 4: Legacy state migration
- Property 5: Proxy enable sequence
- Property 6: Proxy disable completeness
- Property 7: Error aggregation
- Property 8: Status bar state reflection
- Property 9: Command link validation
- Property 10: Status bar internationalization

#### 3. Integration Tests

- **Purpose**: Verify end-to-end workflows
- **Characteristics**:
  - Test interactions between components
  - Use actual Git/npm commands when necessary
  - Verify multi-instance sync scenarios
  - Verify fallback flows

### Test Performance Optimization

#### Iteration Count Control via Environment Variables

```typescript
// src/test/helpers.ts
export function getTestIterations(): number {
    return process.env.CI ? 100 : 10;
}
```

- **Development mode**: 10 iterations (fast feedback)
- **CI mode**: 100 iterations (comprehensive verification)

#### Parallel Execution

- `npm run test:unit:parallel` enables Mocha parallel execution

#### Mock Usage

- External commands (git, npm) are mocked by default
- Only integration tests use actual commands

## Security Considerations

### 1. Command Injection Prevention

- InputSanitizer validates all input
- Commands are executed using `execFile()` (not via shell) to prevent injection
- Shell metacharacter detection and rejection

### 2. Credential Masking

- Automatic masking in Logger, OutputChannelManager, and ProxyChangeLogger
- Credentials (username:password) in logs and UI are replaced with `***:***`

### 3. URL Validation

ProxyUrlValidator performs strict validation:

- Protocol validation (http:// or https:// only)
- Hostname validity check
- Port number range check (1–65535)

### 4. File Operation Safety

- SharedStateFile uses write-then-rename pattern for atomic writes
- InstanceRegistry uses mutex-protected file operations
- GitConfigManager uses cross-process mutex to avoid lock contention

## Performance Considerations

### Benefits of File Size Reduction

- **Build time**: Module splitting enables parallel compilation
- **Incremental builds**: Only changed modules are recompiled
- **Memory usage**: Only required modules are loaded

### Startup Time

- **12-phase staged initialization**: Components loaded sequentially as needed
- **Optional SyncManager initialization**: Falls back to standalone mode on failure

### Auto Mode Monitoring

- **Configurable polling interval**: Default 30 seconds
- **Debouncing**: 1-second debounce to suppress unnecessary checks
- **Exponential backoff**: Automatic retry on detection failure (up to 3 times)
- **Efficient detection**: Early return when no changes are detected
- **Connection test scheduling**: Tests run at 30s–10min intervals

### Multi-Instance Synchronization

- **File watching**: Real-time detection via `fs.watch` (100ms debounce)
- **Polling fallback**: Periodic polling as backup when `fs.watch` is unavailable
- **Zombie process detection**: Inactive instances auto-cleaned via 30s heartbeat timeout

## Extensibility

### Adding a New Command

1. Create `commands/NewCommand.ts`
2. Implement `executeNewCommand(ctx: CommandContext)`
3. Add registration to `CommandRegistry.registerAll()`

### Adding a New Configuration Manager

1. Create `config/NewConfigManager.ts`
2. Implement `setProxy()`, `unsetProxy()`, `getProxy()`
3. Add to `ProxyApplier` constructor

### Adding New Property Tests

1. Add the property to design documents
2. Implement tests in `src/test/*.property.test.ts`
3. Add required generators to `generators.ts`

### Adding a New Language

1. Create `src/i18n/locales/xx.json`
2. Add to I18nManager locale mapping
3. Run `npm run gen:nls` to generate `package.nls.xx.json`

## References

- [VSCode Extension API](https://code.visualstudio.com/api)
- [fast-check Documentation](https://fast-check.dev/)
- [Property-Based Testing](https://hypothesis.works/articles/what-is-property-based-testing/)
- [SOLID Principles](https://en.wikipedia.org/wiki/SOLID)

## Changelog

- **2024-12**: Initial version created (after refactoring completion)
- **2025-03**: Document update — Reflects multi-instance sync, monitoring enhancements, error handling enhancements, TerminalEnvConfigManager, and expanded language support
