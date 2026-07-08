/**
 * @file extension.ts
 * @description Main entry point for the otak-proxy extension
 *
 * Requirements:
 * - 1.1: Simplified extension entry point
 * - 1.2: Modular architecture
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from './core/types';
import { ProxyStateManager } from './core/ProxyStateManager';
import { ProxyApplier } from './core/ProxyApplier';
import { ExtensionInitializer } from './core/ExtensionInitializer';
import { ProxyUrlValidator } from './validation/ProxyUrlValidator';
import { InputSanitizer } from './validation/InputSanitizer';
import { GitConfigManager } from './config/GitConfigManager';
import { VscodeConfigManager } from './config/VscodeConfigManager';
import { NpmConfigManager } from './config/NpmConfigManager';
import { PipConfigManager } from './config/PipConfigManager';
import { TerminalEnvConfigManager } from './config/TerminalEnvConfigManager';
import { SystemProxyDetector } from './config/SystemProxyDetector';
import { UserNotifier } from './errors/UserNotifier';
import { Logger } from './utils/Logger';
import { ProxyMonitor } from './monitoring/ProxyMonitor';
import { ProxyChangeLogger } from './monitoring/ProxyChangeLogger';
import { I18nManager } from './i18n/I18nManager';
import { StatusBarManager } from './ui/StatusBarManager';
import { createCommandRegistry } from './commands/CommandRegistry';
import { SyncManager, SyncConfigManager, SyncStatusProvider, registerSyncStatusCommand } from './sync';
import { ProxyRemediationService, ProxyApplyTrigger } from './remediation/ProxyRemediationService';
import { ProxyApplyOptions } from './core/ProxyApplierTypes';
import { readV3Settings } from './core/V3Settings';

// Module-level instances
let proxyStateManager: ProxyStateManager;
let proxyApplier: ProxyApplier;
let statusBarManager: StatusBarManager;
let initializer: ExtensionInitializer;
let proxyMonitor: ProxyMonitor;
let syncManager: SyncManager | null = null;
let syncConfigManager: SyncConfigManager | null = null;
let syncStatusProvider: SyncStatusProvider | null = null;
let proxyRemediationService: ProxyRemediationService;

// The first-run setup prompt is user-driven and may remain open indefinitely.
// It must not block activation or command availability.
let initialSetupApplication: Promise<void> = Promise.resolve();
// The startup proxy enforcement can run a full diagnostics pass and delayed
// retries (5s timeouts each on a broken corporate network). It must not block
// activation, so it runs as a tracked background task. deactivate() and tests
// await this to observe completion.
let startupProxyApplication: Promise<void> = Promise.resolve();
// Bumped on every activate()/deactivate() so an in-flight startup task can bail
// out of its post-apply steps if it has been superseded (re-activation) or torn
// down, instead of starting monitoring/sync after the window is gone.
let activationGeneration = 0;
let startupApplyRunner: (state: ProxyState, terminalEnvManager?: TerminalEnvConfigManager) => Promise<void> =
    (state, terminalEnvManager) => applyStartupProxyState(state, terminalEnvManager);

/** Resolves when the (fire-and-forget) startup proxy enforcement has settled. */
export function whenStartupProxyApplied(): Promise<void> {
    return startupProxyApplication;
}

/** Resolves when the first-run setup prompt/background task has settled. */
export function whenInitialSetupCompleted(): Promise<void> {
    return initialSetupApplication;
}

/** Test-only seam: override the startup apply to assert non-blocking activation. */
export function __setStartupApplyRunnerForTest(
    runner?: (state: ProxyState, terminalEnvManager?: TerminalEnvConfigManager) => Promise<void>
): void {
    startupApplyRunner = runner ?? ((state, terminalEnvManager) => applyStartupProxyState(state, terminalEnvManager));
}

async function publishProxyState(state: ProxyState): Promise<void> {
    if (syncManager && syncConfigManager?.isSyncEnabled()) {
        await syncManager.notifyChange(state);
    }
}

type EnvironmentVariableCollectionLike = {
    replace(name: string, value: string): void;
    delete(name: string): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isEnvironmentVariableCollection(value: unknown): value is EnvironmentVariableCollectionLike {
    return isRecord(value) &&
        typeof value['replace'] === 'function' &&
        typeof value['delete'] === 'function';
}

interface CoreServices {
    config: vscode.WorkspaceConfiguration;
    sanitizer: InputSanitizer;
    terminalEnvManager?: TerminalEnvConfigManager;
    userNotifier: UserNotifier;
    proxyChangeLogger: ProxyChangeLogger;
    systemProxyDetector: SystemProxyDetector;
}

function initializeI18n(): void {
    const i18n = I18nManager.getInstance();
    i18n.initialize();
    Logger.log(`I18n initialized with locale: ${i18n.getCurrentLocale()}`);
}

function createCoreServices(context: vscode.ExtensionContext): CoreServices {
    const sanitizer = new InputSanitizer();
    const config = vscode.workspace.getConfiguration('otakProxy');
    const v3Settings = readV3Settings(config);
    const envCollection = (context as unknown as Record<string, unknown>)['environmentVariableCollection'];
    const terminalEnvManager = isEnvironmentVariableCollection(envCollection)
        ? new TerminalEnvConfigManager(envCollection, {
            includeLowercase: process.platform !== 'win32',
            maskOnUnset: v3Settings.terminalOffMaskingEnabled,
            description: 'Managed by otak-proxy for newly created terminals.'
        })
        : undefined;
    const detectionSourcePriority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);

    return {
        config,
        sanitizer,
        terminalEnvManager,
        userNotifier: new UserNotifier(),
        proxyChangeLogger: new ProxyChangeLogger(sanitizer),
        systemProxyDetector: new SystemProxyDetector(detectionSourcePriority)
    };
}

function initializeCoreManagers(context: vscode.ExtensionContext, services: CoreServices): void {
    proxyStateManager = new ProxyStateManager(context);
    proxyApplier = new ProxyApplier(
        new GitConfigManager(),
        new VscodeConfigManager(),
        new NpmConfigManager(),
        new ProxyUrlValidator(),
        services.sanitizer,
        services.userNotifier,
        proxyStateManager,
        services.terminalEnvManager,
        new PipConfigManager()
    );
    proxyRemediationService = new ProxyRemediationService(
        context,
        () => proxyStateManager.getState()
    );

    initializer = new ExtensionInitializer({
        extensionContext: context,
        proxyStateManager,
        proxyApplier,
        applyProxySettings: (url, enabled, options) => applyProxySafely(url, enabled, 'autoDetection', options),
        systemProxyDetector: services.systemProxyDetector,
        userNotifier: services.userNotifier,
        sanitizer: services.sanitizer,
        proxyChangeLogger: services.proxyChangeLogger,
        publishProxyState
    });

    proxyMonitor = initializer.initializeProxyMonitor();
}

async function applyProxySafely(
    url: string,
    enabled: boolean,
    trigger: ProxyApplyTrigger,
    options?: ProxyApplyOptions
): Promise<boolean> {
    if (!proxyRemediationService) {
        return await proxyApplier.applyProxy(url, enabled, options);
    }

    const result = await proxyRemediationService.applyWithSafety(
        url,
        enabled,
        {
            ...options,
            trigger
        },
        (proxyUrl, shouldEnable, applyOptions) => proxyApplier.applyProxyDetailed(proxyUrl, shouldEnable, applyOptions)
    );
    return result.success;
}

function initializeStatusBar(context: vscode.ExtensionContext, services: CoreServices): void {
    statusBarManager = new StatusBarManager(context);
    statusBarManager.setMonitorProviders(proxyMonitor, services.proxyChangeLogger);
    initializer.setStatusBarUpdater((s) => statusBarManager.update(s));
}

async function applyRemoteSyncState(remoteState: ProxyState): Promise<void> {
    Logger.log('Received remote state change from another instance');
    await proxyStateManager.saveState(remoteState);
    const localState = await proxyStateManager.getState();
    const activeUrl = proxyStateManager.getActiveProxyUrl(localState);

    if (localState.mode !== ProxyMode.Off && activeUrl) {
        await applyProxySafely(activeUrl, true, 'sync', { silent: true });
    } else if (localState.mode === ProxyMode.Off) {
        await applyProxySafely('', false, 'sync', { silent: true });
    }

    if (localState.mode === ProxyMode.Auto) {
        await initializer.startSystemProxyMonitoring();
    } else {
        await initializer.stopSystemProxyMonitoring();
    }

    statusBarManager.update(localState);
}

function registerSyncEventHandlers(context: vscode.ExtensionContext): void {
    syncManager!.on('remoteChange', async (remoteState) => {
        await applyRemoteSyncState(remoteState);
    });

    syncManager!.on('conflictResolved', (conflictInfo) => {
        Logger.log('Sync conflict resolved:', conflictInfo);
        syncStatusProvider?.showConflictResolved();
    });

    syncManager!.on('syncStateChanged', (status) => {
        syncStatusProvider?.update(status);
    });

    syncStatusProvider = new SyncStatusProvider(98);
    registerSyncStatusCommand(context, syncStatusProvider);
    context.subscriptions.push({ dispose: () => syncStatusProvider?.dispose() });
}

function initializeSync(context: vscode.ExtensionContext): void {
    try {
        syncConfigManager = new SyncConfigManager();

        if (!context.globalStorageUri) {
            return;
        }

        const extensionVersion = context.extension?.packageJSON?.version
            ? String(context.extension.packageJSON.version)
            : 'unknown';
        syncManager = new SyncManager(
            context.globalStorageUri.fsPath,
            `window-${process.pid}`,
            syncConfigManager,
            extensionVersion
        );
        registerSyncEventHandlers(context);
    } catch (error) {
        Logger.warn('Failed to initialize SyncManager, running in standalone mode:', error);
    }
}

async function migrateManualUrlFromConfig(
    state: ProxyState,
    config: vscode.WorkspaceConfiguration
): Promise<ProxyState> {
    const configProxyUrl = config.get<string>('proxyUrl', '');
    if (configProxyUrl && !state.manualProxyUrl) {
        state.manualProxyUrl = configProxyUrl;
        await proxyStateManager.saveState(state);
    }

    return state;
}

function registerExtensionCommands(context: vscode.ExtensionContext, services: CoreServices): void {
    createCommandRegistry({
        context,
        getProxyState: () => proxyStateManager.getState(),
        saveProxyState: async (_ctx, s) => {
            await proxyStateManager.saveState(s);
            await publishProxyState(s);
        },
        getActiveProxyUrl: (s) => proxyStateManager.getActiveProxyUrl(s),
        getNextMode: (mode) => proxyStateManager.getNextMode(mode),
        applyProxySettings: (url, enabled) => applyProxySafely(url, enabled, 'manual', { showProgress: true }),
        updateStatusBar: (s) => statusBarManager.update(s),
        checkAndUpdateSystemProxy: async () => initializer.checkAndUpdateSystemProxy(),
        startSystemProxyMonitoring: () => initializer.startSystemProxyMonitoring(),
        stopSystemProxyMonitoring: () => initializer.stopSystemProxyMonitoring(),
        userNotifier: {
            showSuccess: (key, params) => services.userNotifier.showSuccess(key, params),
            showWarning: (key, params) => services.userNotifier.showWarning(key, params),
            showError: (key, suggestions) => services.userNotifier.showError(key, suggestions),
            showErrorWithDetails: (message, details, suggestions, params) =>
                services.userNotifier.showErrorWithDetails(message, details, suggestions, params),
            showProgressNotification: (title, task, cancellable) =>
                services.userNotifier.showProgressNotification(title, task, cancellable)
        },
        sanitizer: services.sanitizer,
        proxyMonitor,
        systemProxyDetector: services.systemProxyDetector
    });
}

async function startSyncAndLoadSharedState(state: ProxyState): Promise<ProxyState> {
    if (!syncManager) {
        return state;
    }

    try {
        await syncManager.start();
        Logger.log('SyncManager started successfully');
        return await loadSharedStateIfEnabled(state);
    } catch (error) {
        Logger.warn('Failed to start SyncManager:', error);
        return state;
    }
}

async function loadSharedStateIfEnabled(state: ProxyState): Promise<ProxyState> {
    if (!syncConfigManager?.isSyncEnabled()) {
        return state;
    }

    const sharedState = syncManager?.getCurrentSharedState();
    if (!sharedState) {
        return state;
    }

    await proxyStateManager.saveState(sharedState);
    const updatedState = await proxyStateManager.getState();
    statusBarManager.update(updatedState);
    return updatedState;
}

/**
 * A stable signature of everything applyStartupProxyState acts on. Used to detect
 * whether the persisted state changed while the (slow) startup enforcement ran,
 * so we can reconcile on the latest instead of a stale activation snapshot (#12).
 */
function startupEnforcementTarget(state: ProxyState): string {
    return JSON.stringify({
        mode: state.mode,
        activeUrl: proxyStateManager.getActiveProxyUrl(state),
        autoModeOff: state.autoModeOff === true
    });
}

async function applyStartupProxyState(state: ProxyState, terminalEnvManager?: TerminalEnvConfigManager): Promise<void> {
    const activeUrl = proxyStateManager.getActiveProxyUrl(state);

    if (shouldEnsureStartupProxyDisabled(state, activeUrl)) {
        await clearManagedStartupProxyState(terminalEnvManager);
        return;
    }

    if (activeUrl) {
        await applyProxySafely(activeUrl, true, 'startup');
    }
}

function shouldEnsureStartupProxyDisabled(state: ProxyState, activeUrl: string): boolean {
    return state.mode === ProxyMode.Off ||
        (state.mode === ProxyMode.Auto && state.autoModeOff === true && !activeUrl);
}

async function clearManagedStartupProxyState(terminalEnvManager?: TerminalEnvConfigManager): Promise<void> {
    if (terminalEnvManager) {
        await terminalEnvManager.unsetProxy();
    }

    await applyProxySafely('', false, 'startup', { silent: true });
}

async function updateMonitoringForState(state: ProxyState): Promise<void> {
    if (state.mode === ProxyMode.Auto) {
        await initializer.startSystemProxyMonitoring();
    } else {
        await initializer.stopSystemProxyMonitoring();
    }
}

async function publishStartupSyncState(state: ProxyState): Promise<void> {
    if (!syncManager || !syncConfigManager?.isSyncEnabled()) {
        return;
    }

    try {
        await syncManager.notifyChange(state);
    } catch (error) {
        Logger.warn('Failed to publish initial sync state:', error);
    }
}

function registerAutoTestConfigListener(context: vscode.ExtensionContext): void {
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('otakProxy.testInterval')) {
            const newInterval = vscode.workspace.getConfiguration('otakProxy').get<number>('testInterval', 60);
            initializer.handleConfigurationChange('testInterval', newInterval);
        }

        if (e.affectsConfiguration('otakProxy.autoTestEnabled')) {
            const enabled = vscode.workspace.getConfiguration('otakProxy').get<boolean>('autoTestEnabled', true);
            initializer.handleConfigurationChange('autoTestEnabled', enabled);
        }
    });

    context.subscriptions.push(configChangeDisposable);
}

/**
 * Perform initial setup for the extension
 * This function handles the initial setup dialog and applies settings.
 *
 * Requirement 1.4, 5.3: Handle initialization gracefully
 *
 * @param context - The extension context
 */
export async function performInitialSetup(context: vscode.ExtensionContext): Promise<boolean> {
    try {
        const hasSetup = context.globalState.get('hasInitialSetup', false);
        if (!hasSetup) {
            // If initializer is not initialized (e.g., in tests), skip setup
            if (initializer) {
                await initializer.askForInitialSetup();
            }
            await context.globalState.update('hasInitialSetup', true);
            return true;
        }
        return false;
    } catch (error) {
        Logger.error('Initial setup failed:', error);
        // Continue with default state - don't throw
        return false;
    }
}

function startInitialSetupInBackground(context: vscode.ExtensionContext, generation: number): void {
    initialSetupApplication = (async () => {
        const setupRan = await performInitialSetup(context);
        if (!setupRan || generation !== activationGeneration) {
            return;
        }

        const latestState = await proxyStateManager.getState();
        statusBarManager.update(latestState);
        await updateMonitoringForState(latestState);
        await publishStartupSyncState(latestState);
    })().catch(error => Logger.warn('Initial setup background task failed:', error));
}

/**
 * Activate the extension
 * Main entry point for extension initialization
 *
 * Requirements:
 * - 1.1: Simplified activation
 * - 1.2: Modular initialization
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.log('Extension "otak-proxy" is now active.');

    initializeI18n();
    const services = createCoreServices(context);
    initializeCoreManagers(context, services);
    initializeSync(context);
    initializeStatusBar(context, services);

    let state = await proxyStateManager.getState();
    state = await migrateManualUrlFromConfig(state, services.config);
    registerExtensionCommands(context, services);

    statusBarManager.update(state);
    const generation = ++activationGeneration;
    startInitialSetupInBackground(context, generation);
    state = await startSyncAndLoadSharedState(state);

    // Run the whole startup enforcement (apply -> monitoring -> sync) as one
    // ordered background task so activation is not blocked on diagnostics passes
    // + delayed retries (#12). Keeping the steps sequential (rather than racing the
    // startup apply against the immediate monitoring check, whose apply lock skips
    // rather than queues) keeps them from diverging from the saved state. The
    // config listener stays synchronous: it is cheap and should be live immediately.
    startupProxyApplication = (async () => {
        // A user command (e.g. toggle) can run the moment activation resolves and
        // persist a newer state while this slow task is mid-flight. Reconcile until
        // the persisted state stops changing under us (bounded), so we finish
        // owning the state the user last chose — never a stale snapshot. This
        // matters most for monitoring, which is the reconciliation owner: starting
        // or stopping it from a stale mode can strand the config (e.g. saved=Auto
        // but proxy cleared and the monitor stopped) with nothing left to fix it.
        // The bound keeps a pathological command storm from looping forever; the
        // tiny remaining window (a command landing between the final read and the
        // monitoring update) is the same irreducible concurrency the steady-state
        // monitor-vs-command path already has. (#12)
        let target = state;
        for (let attempt = 0; attempt < 3; attempt++) {
            const applyTarget = attempt === 0 ? startupApplyRunner : applyStartupProxyState;
            await applyTarget(target, services.terminalEnvManager);
            if (generation !== activationGeneration) {
                return;
            }
            const latest = await proxyStateManager.getState();
            const stable = startupEnforcementTarget(latest) === startupEnforcementTarget(target);
            target = latest;
            if (stable) {
                break;
            }
        }
        if (generation !== activationGeneration) {
            return;
        }
        await updateMonitoringForState(target);
        await publishStartupSyncState(target);
    })().catch(error => Logger.warn('Startup proxy enforcement failed:', error));

    registerAutoTestConfigListener(context);
}

/**
 * Deactivate the extension
 * Clean up resources
 */
/**
 * Waits for the in-flight startup enforcement to settle, but never longer than
 * timeoutMs so a stuck apply cannot hang teardown/shutdown indefinitely.
 */
async function settleStartupApplication(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => {
        timer = setTimeout(() => {
            Logger.warn(`Startup proxy enforcement did not settle within ${timeoutMs}ms; continuing teardown.`);
            resolve();
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        await Promise.race([startupProxyApplication.catch(() => undefined), timeout]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

export async function deactivate(): Promise<void> {
    // Supersede any in-flight startup task so it does not start monitoring/sync
    // after teardown (e.g. if the bounded settle below times out), then let it
    // settle (bounded) before tearing down so we do not stop it mid-apply (#12).
    activationGeneration++;
    await settleStartupApplication(15000);
    startupProxyApplication = Promise.resolve();

    // Stop SyncManager (Feature: multi-instance-sync)
    if (syncManager) {
        try {
            await syncManager.stop();
            Logger.log('SyncManager stopped');
        } catch (error) {
            Logger.warn('Error stopping SyncManager:', error);
        }
    }

    // Dispose SyncConfigManager
    if (syncConfigManager) {
        syncConfigManager.dispose();
    }

    // Stop monitoring
    if (initializer) {
        await initializer.stopSystemProxyMonitoring();
    }

    // Stop ProxyMonitor
    if (proxyMonitor) {
        proxyMonitor.stop();
    }
}
