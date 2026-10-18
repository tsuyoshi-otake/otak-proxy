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
│   ├── types.ts         # Common type definitions (ProxyMode: Off/Auto; Manual is a legacy value migrated to Auto)
│   ├── ProxyStateManager.ts    # State persistence
│   ├── ProxyApplier.ts         # Proxy configuration orchestration
│   ├── ProxyApplyPlan.ts       # Write plan resolution for one apply attempt (#108)
│   ├── AppliedProxyProvenance.ts # State -> applied proxy + provenance (echo suppression)
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
│   └── ProxyTestScheduler.ts    # Periodic connection test scheduler
│
├── remediation/         # Safe apply orchestration
│   ├── ProxyApplyAttempt.ts    # One apply attempt: one state read, one shared write plan
│   └── ProxyRemediationService.ts  # Credential consent, target policy, retries
│
├── sync/                # Multi-instance synchronization
│   ├── SyncManager.ts          # Sync orchestrator
│   ├── InstanceRegistry.ts     # Instance registration and lifecycle management
│   ├── SharedStateFile.ts      # Shared state file (atomic read/write)
│   ├── FileWatcher.ts          # File change monitoring (with debounce)
│   ├── ConflictResolver.ts     # Version-first conflict resolution
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
│   └── OutputChannelManager.ts  # Output channel log management (singleton)
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
│       ├── zh-tw.json          # Traditional Chinese
│       ├── es.json             # Spanish (Argentina, Mexico)
│       ├── pt-br.json          # Portuguese (Brazil)
│       ├── fr.json             # French (France, Canada)
│       ├── de.json             # German (Germany)
│       ├── hi.json             # Hindi (India)
│       ├── id.json             # Indonesian (Indonesia)
│       ├── it.json             # Italian (Italy)
│       ├── ru.json             # Russian (Russia)
│       ├── ar.json             # Arabic (Saudi Arabia)
│       └── tr.json             # Turkish (Turkey)
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
syncManager.on('remoteChange', (delivery) => { /* delivery: {state, version}; apply via absorbRemoteChange */ });
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
   ├─→ Queues toggles so they run one at a time
   └─→ Each queued toggle starts with a first read that fixes the
       current mode and the next mode (Off ↔ Auto) for the whole
       toggle
   ↓
3. runToggleRound()
   ├─→ Re-read state; a moved mode supersedes the toggle
   │   (status bar refresh only)
   └─→ Off → Auto with no detected proxy: run detection first,
       then read the state again
   ↓
4. Decide the next state on a copy
   └─→ Notifications and prompts the decision wants are only collected
   ↓
5. commitDecidedPatch() (ApplyConvergence, at most 3 attempts)
   └─→ Commit the changed fields plus convergencePending: true onto
       the latest stored state with a revision check; guarded by
       "same mode and same proxy identity as the decision's basis";
       when the attempts run out, one final guarded read decides
       between moved and exhausted
   ↓
6. Commit landed → applyCommittedToggle()
   ├─→ Off: stop monitoring, then remove the proxy settings
   │       (GitConfigManager, VscodeConfigManager, NpmConfigManager,
   │        TerminalEnvConfigManager); ProxyApplier shows "proxy
   │       disabled" (the toggle's call is not silent)
   ├─→ Auto: apply the proxy settings (same managers); ProxyApplier
   │       shows "proxy configured" with the masked URL
   │   (when a target failed, the aggregated error is shown instead)
   ├─→ clearPendingThenPublish(): clear the pending flag and publish
   │   the state (SyncManager.notifyChange reaches other windows
   │   when sync is on)
   ├─→ Auto: start monitoring only after publishing
   ├─→ StatusBarManager.update() from the stored state
   └─→ Run the collected notifications
   ↓
7. Commit did not land
   ├─→ Mode changed (also detected by the final guarded read after
   │   the last attempt): superseded, refresh status bar only
   ├─→ Same mode, new proxy identity: decide again (at most 3 rounds)
   └─→ Every attempt lost and the final read still passes the
       guard, or the rounds ran out: "Failed to toggle proxy mode"
       is shown, nothing is applied
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
   ├─→ Success: apply attempt (ends in ProxyApplier.applyProxyDetailed())
   └─→ Failure: SystemProxyUpdateService falls back to the configured
                manual proxy (when enableFallback is on) or direct
                connection
   ↓
7. StatusBarManager.update()
   └─→ Update UI
```

### Multi-Instance Sync Flow

Ordering between windows uses the shared file's `version` (a compare-and-set
counter in the file itself), never a window's `revision`: `revision` is a
per-window monotonic counter, so two windows' counters are unrelated numbers
(#108). SyncManager owns both watermarks per window:

- `localHistoryRevision` — the highest `revision` this window published or
  adopted; a `notifyChange` snapshot below it is a stale local snapshot and is
  discarded without writing.
- `highestSharedVersion` — the highest shared-file `version` this window
  published or adopted; a remote delivery at or below it is superseded and is
  skipped without saving, applying, monitoring, status updates, or failure
  notifications.

Two serialized sections keep the ordering consistent without deadlocking:

- `transitionQueue` (short bookkeeping only): publication, reassert, and
  adoption (version check → save → advance watermarks). An adoption is
  enqueued **at emission** — the `remoteChange` listener calls
  `absorbRemoteChange` synchronously — so adoptions run in emission order,
  interleaved with this window's own publications. A queued delivery has
  already moved the fence and the watermark before its convergence starts:
  a background result that captured its generation earlier is discarded
  instead of published over the delivery. Tasks here never await apply,
  monitoring, or another delivery.
- `deliveryQueue` (remote convergence): each `remoteChange` delivery —
  `{state, version}` — converges one at a time, in emission order. The
  convergence awaits the outcome of its own adoption instead of starting it,
  then works from this window's *current* local state (which may already be
  a later delivery's adopted state or a newer local change); each
  convergence brings this window's targets, monitoring and status to that
  current state. A delivery whose monitoring start/stop publishes through
  notifyChange, or awaits a concurrent publication, does not deadlock
  because publications use the transition section, not the delivery chain.

```
1. Instance A: Changes proxy settings
   ↓
2. SyncManager.notifyChange() → transition section
   └─→ SharedStateFile.compareAndSwap() (atomic write-then-rename,
       version = max(disk, current) + 1)
   ↓
3. Instance B: FileWatcher detects file change
   ↓
4. SyncManager.reconcileWithSharedFile()
   ├─→ Compare local state with remote state
   └─→ Resolve conflicts via ConflictResolver (version first, then timestamp)
   ↓
5. Instance B: emit 'remoteChange' {state, version}
   → SyncManager.absorbRemoteChange()
   ├─→ transition section (at emission): adopt if
   │   version > highestSharedVersion — save, advance watermarks — else skip
   └─→ delivery chain (one at a time, emission order):
       ├─→ await this delivery's adoption outcome; skipped → stop here
       ├─→ credential gate → fenced bookkeeping write
       ├─→ applyProxySafely → apply attempt → ProxyApplier.applyProxyDetailed()
       │   (skipped when this window's own record proves the same plan applied)
       └─→ monitoring start/stop + StatusBarManager.update()
```

**Known limitations** (#108):

- A background publication from another window (a scheduled connection test,
  or a detection) that lands while this window's own toggle or Configure
  apply is still running is adopted and replaces the unpublished change, so
  the toggle reverts when its own publication is then judged stale. The
  publisher side of the same race: this window can publish a background
  result within the file watcher's 100 ms debounce of another window's
  toggle, before adopting that toggle.
- The watermarks live in memory only, so a reloaded window starts with both
  at 0. At activation the window saves the shared file's current state as
  its own state, applies it through the startup path and publishes it; that
  publication sets both watermarks again. A delivery that the previous
  extension host had emitted but not yet converged is not delivered again:
  the startup apply of the shared file's state takes its place.
- Receiver dedupe counts a target reported `skippedUnavailable` (the tool
  was not installed) as written: a tool installed later is configured at the
  next real plan change or local apply, not by the next identical sync
  publication. Likewise, a hand edit of a configured file (`.npmrc`,
  `.gitconfig`) made after the last apply stays until the next real proxy
  change or local apply — the next identical publication no longer rewrites
  it.

## Module Details

### Core Modules

#### extension.ts
- **Responsibility**: Entry point, 12-phase initialization orchestration
- **Lines**: ~350
- **Key features**:
  - `activate()`: Extension initialization (12 phases)
  - `deactivate()`: SyncManager shutdown, resource disposal, monitoring stop
  - `warnOnInvalidConfiguredProxyUrl()`: a non-empty but invalid
    `otakProxy.proxyUrl` setting is logged once per activation with its
    credentials masked (no notification); every read of the setting validates
    and canonicalizes it inside ProxyStateManager, so an invalid value is
    ignored there without logging (#108)
  - Event listener setup (sync events, configuration changes)

#### ExtensionInitializer
- **Responsibility**: First-launch processing, state migration, component initialization
- **Key features**:
  - First-launch detection and setup dialog (`InitialSetupFlow.askForInitialSetup`): the setup decision commits through `commitDecidedPatch` like the toggle; an answer that could not be saved (`exhausted`) shows `error.initialSetupNotSaved` and `performInitialSetup` leaves `hasInitialSetup` unset, so the setup is offered again on the next start
  - Migration from legacy settings
  - Auto mode monitoring startup

#### ProxyStateManager
- **Responsibility**: ProxyState persistence and retrieval
- **Key features**:
  - `getState()`: State loading (with automatic fallback); persisted Manual is migrated to Auto; URL credentials are split out to SecretStorage on save and re-hydrated on load, keyed by the credential-free public URL; a configured `otakProxy.proxyUrl` is validated and canonicalized on every read — an invalid value is ignored (no SecretStorage write, no settings rewrite, no log line), and the one-time v3 migration canonicalizes the setting through the same path before consuming it
  - `requiresAuth` / `authRequiredProxyUrls` (non-secret, synced): `requiresAuth` records that a URL field carried credentials and `authRequiredProxyUrls` lists those addresses as credential-free public URLs; every apply attempt is refused rather than writing an address without the credentials it requires on this machine — the per-address gate runs inside `runProxyApplyAttempt` before consent, so monitor, toggle, sync and startup applies are all covered (#108)
  - `saveState()`: State saving (with automatic fallback)
  - `getNextMode()`: Off ↔ Auto (a leftover Manual value also advances to Auto)
  - `migrateOldSettings()`: Migration from legacy settings
- **Tests**: ProxyStateManager.test.ts, ProxyStateManager.property.test.ts

#### ProxyApplier
- **Responsibility**: Proxy configuration application orchestration
- **Key features**:
  - `applyProxy()`: Enable proxy (Git, VS Code, npm, terminal environment variables)
  - `disableProxy()`: Disable proxy
  - Error aggregation and user notification
  - Writes exactly the plan it is handed: the per-scheme URLs and bypass are
    resolved upstream, and the applier never reads the state to resolve them (#108)
- **Tests**: ProxyApplier.test.ts, ProxyApplier.property.test.ts

#### ProxyApplyAttempt (`src/remediation/ProxyApplyAttempt.ts`)
- **Responsibility**: The composition every apply path (`applyProxySafely`) runs
- **Invariant**: one state read per attempt provides both the generation fence
  and the write plan; credential consent and `otakProxy.credentialTargetPolicy`
  judge every credential-bearing URL in that plan; retries reuse it (#108)
- **Gate**: `planUrlsMissingRequiredCredentials` runs after the plan is resolved and
  before consent or any write; a refused attempt records
  `UNRESOLVED_LOCAL_CREDENTIAL_ERROR` through a generation-fenced commit (#108)
- **Basis**: the fence's generation is handed to the applier, which records its
  per-target results against that state — a result commit that lands after
  another writer committed a newer desired state is discarded instead (#108)
- The startup reconcile signature (`startupEnforcementTarget`) covers every
  input `applyStartupProxyState` reads, including the split fields and
  `authRequiredProxyUrls`, so a credential-only change re-runs the startup
  apply on the latest state (#108)

### Command Modules

#### CommandRegistry
- **Responsibility**: Registration of all commands and event listeners
- **Key features**:
  - `registerAll()`: Register all commands
  - Configuration change listeners; an `otakProxy.proxyUrl` change is validated
    to the canonical form before it is saved and published — an invalid value
    is rejected with the invalid-URL error and touches neither — and saving
    recomputes `requiresAuth` / `authRequiredProxyUrls` from the live URLs like
    the Configure command, so a credential-free URL cannot inherit a sticky
    `requiresAuth` (#108)
  - Window focus listeners

#### ToggleProxyCommand
- **Responsibility**: Mode switching (Off ↔ Auto)
- **Flow**:
  1. First read fixes the current mode and the next mode (Off ↔ Auto) for the whole toggle
  2. Each round re-reads the state; Off → Auto with no detected proxy runs detection first, then reads again
  3. The next state is decided on a copy; notifications and prompts the decision wants are only collected here
  4. `commitDecidedPatch` commits the changed fields plus `convergencePending: true` onto the latest stored state with a revision check, guarded by same mode and same proxy identity (at most 3 attempts); when the attempts run out, a final guarded read decides between `moved` and `exhausted`
  5. On commit: Off stops monitoring and removes the proxy settings, Auto applies them; `ProxyApplier` shows "proxy configured" with the masked URL after an apply and "proxy disabled" after a removal (the toggle's call is not silent), or the aggregated error when a target failed; `clearPendingThenPublish` clears the pending flag and publishes the state (reaching other windows via `SyncManager.notifyChange` when sync is on); Auto then starts monitoring; the status bar refreshes from the stored state and the collected notifications run
  6. When the commit does not land: a mode change supersedes the toggle (status bar refresh only); a same-mode identity change re-decides (at most 3 rounds); every attempt lost with the basis still current, or the rounds exhausted, shows "Failed to toggle proxy mode" and nothing is applied

#### ConfigureUrlCommand
- **Responsibility**: Configure the Auto fallback proxy URL (`otak: Configure Manual Proxy`)
- **Flow**:
  1. Prompt user for URL input; the prefill is the credential-free public URL,
     so a stored password is never shown in clear (#108)
  2. Validate URL; an input without credentials that names the same address as
     the stored credential-bearing URL keeps the stored credentials, a URL
     with credentials replaces them, and a different credential-free URL
     stores none
  3. Store the URL as the Auto fallback (`manualProxyUrl` / `otakProxy.proxyUrl`)
     and recompute `requiresAuth` / `authRequiredProxyUrls` from the live URLs
  4. Apply only if a leftover Manual mode is still current (hydrate migrates Manual → Auto)

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
  - On POSIX the mutex and the apply locks live in a per-user directory `<tmpdir>/otak-proxy-<uid>`, created 0700 and accepted only when it is a real directory owned by the uid with no group/other permission bits (`src/utils/PerUserLockDir.ts`). Windows keeps the shared temp paths because its temp directory is already per-user, so all of a user's windows still share one lock directory while two users never do. A directory that fails the checks reports an `ioError` lock outcome (applies) or an EACCES write failure (Git) — no silent fallback to a shared path. Residual risks: the lstat check cannot pin the directory between the check and the lock create (lstat-then-open TOCTOU), the wrong-owner check is covered by stubbed-lstat tests only (a real test needs root), and during an upgrade an old and a new window of the same user do not exclude each other until every window has restarted (POSIX only; no dual locking).

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
- **Responsibility**: Logging proxy change and test events
- **Key features**:
  - `logChange()`: Log proxy changes (with credential masking)
  - `logCheck()`: Log test attempts
  - 2 parallel history arrays (max 100 entries each)

#### ProxyConnectionTester
- **Responsibility**: Proxy connection testing (both Auto and Manual modes)
- **Key features**:
  - `testProxyAuto()`: 3s timeout, parallel execution, brief notifications
  - `testProxyManual()`: 5s timeout, detailed notifications
  - Result caching

#### ProxyTestScheduler
- **Responsibility**: Scheduling periodic proxy connection tests
- **Key features**:
  - `start()`: Start scheduler with callback
  - `updateInterval()`: Update test interval (30s–10min)
  - `triggerImmediateTest()`: Immediate test execution
  - Overlapping test prevention

### Sync Modules

#### SyncManager
- **Responsibility**: Multi-instance synchronization orchestrator; sole owner of this window's publication/adoption ordering (the revision fence, the shared-version watermark, and the two serialized sections)
- **Key features**:
  - Instance lifecycle management
  - State change propagation
  - Remote change detection and application (version-ordered deliveries via `absorbRemoteChange`)
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
  - A corrupt or unreadable file reads as no state, and the next write replaces it; stray `*.tmp` files from a crashed write are not removed
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
  - Version-based: the higher version wins
  - Timestamp breaks a tie only when versions are equal; equal version and timestamp: remote wins
  - Updates from the same instance are not conflicts
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

### Internationalization

#### I18nManager
- **Responsibility**: Translation management (singleton)
- **Key features**:
  - `t()`: Get translation by key
  - `getCurrentLocale()`: Get current locale
  - Automatic detection from VS Code language pack
- **Supported languages** (16, covering all G20 countries): English, Japanese, Korean, Vietnamese, Simplified Chinese, Traditional Chinese, Spanish, Portuguese (Brazil), French, German, Hindi, Indonesian, Italian, Russian, Arabic, Turkish

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
it('should toggle from off to auto', async () => {
    const state = { mode: ProxyMode.Off };
    const nextMode = stateManager.getNextMode(state.mode);
    expect(nextMode).toBe(ProxyMode.Auto);
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
- Credentials (username:password) in display text and logs are masked as
  `user:****@host` (a username-only userinfo becomes `****@host`); diagnostics
  and persisted state text use the strict `<credentials>@host` form
- `InputSanitizer` (single-URL `user:****@` display) and `ProxySecretRedactor`
  (strict `<credentials>@` for diagnostics/state text) share one set of
  credential patterns, so every occurrence in a message is masked — including
  credentials after `/`, `:`, `@` and `DOMAIN\user` authorities that URL
  parsing moves into the path (#108). A password with an unencoded `/`, `?` or
  `#` in an absolute URL is masked too: a URL parser rejects such a URL or
  splits the authority at that character, so the pattern's fallback alternative
  consumes the userinfo up to the last `@` of the run; the run stops at the
  next `://` so the scan stays linear. A password with raw whitespace
  (`http://user:pa ss@host:8080`) is masked by a third alternative that runs
  only to the first `@` — a space-containing run that continued to the last
  `@` would swallow the host when the line later contains an e-mail address —
  and that excludes `/` and line breaks so it cannot reach into a later URL or
  the next line. A port followed by an `@` later in the same token
  (`http://localhost:3000/@vite/client`), or on the same line before any `/`
  (`see http://proxy:8080 is down, mail admin@corp` becomes
  `see http://proxy:****@corp`), has the same shape and is masked as well.
  Residual leaks of these patterns, and so of `redactString`, accepted: a
  password with raw whitespace AND a raw `/`, a password with a raw line
  break (alternative 3 stops at line breaks), the part after the first `@`
  of a password with raw whitespace AND a raw `@`, and a scheme-less
  `user:pa ss@host`
- `maskPassword` decides between the parse path and the loose pass on the
  value as typed, as the pre-#108 masker did; on the parse path it masks
  the raw text first and parses that only when the result keeps the host,
  the username and the presence of a password that the parser reads in the
  typed value, otherwise it parses the typed value
  (`http://TOKEN:@h?a:b@host`); it then masks the parser's password, or a
  username-only userinfo as a token, and masks the serialized form again
  (the parser rewrites `\` to `/` for special schemes and drops tabs and
  line breaks); a userinfo match with an empty password, or with a raw `@`
  before its `:`, is masked completely (`****@`)
- When the value does not parse, parses without a host, or parses without
  userinfo and with an empty port (a password that starts with `/`, `?`,
  `#` or `\`: the parser reads `user:` as the host with an empty port and
  moves the password into the path, query or fragment), `maskPassword`
  additionally runs the pre-#108 loose display fallbacks
  (`maskLooseCredentials`): an authority pass (`//x:` to the next `@`) and a
  scheme-less pass (`user:pass@` after text start, whitespace or `=`), both
  global and linear-time. They over-mask — spanning spaces, `/`, quotes and
  line breaks — which the display masker accepted before #108 and the
  diagnostics redactor never did. Values on these paths are shown as typed
  (`http://user:/abc@host:8080` becomes `http://user:****@host:8080`). Of
  the residuals above, `maskPassword` masks the first two; inside text it
  keeps the third (`err http://user:pa ss@w@host x` keeps `w`) and the
  fourth, as the pre-#108 masker did. And as before #108, `maskPassword`
  shows the part of a password after a raw `@` when the parser ends the
  authority at a later `?` or `#` (`https://u:SEC@k?RET@host:8080` keeps
  `RET`); `redactString` masks it
- Git, npm, and pip config managers mask their own error results before
  returning them (execFile errors echo the command line), and `ErrorAggregator`
  masks every error at ingestion, so `lastError`, the tooltip, and
  notifications never hold a password; persistence keeps its own redaction
  (#108)

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
