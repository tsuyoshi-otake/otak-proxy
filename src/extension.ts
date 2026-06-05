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

// Module-level instances
let proxyStateManager: ProxyStateManager;
let proxyApplier: ProxyApplier;
let statusBarManager: StatusBarManager;
let initializer: ExtensionInitializer;
let proxyMonitor: ProxyMonitor;
let syncManager: SyncManager | null = null;
let syncConfigManager: SyncConfigManager | null = null;
let syncStatusProvider: SyncStatusProvider | null = null;

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
    const envCollection = (context as unknown as Record<string, unknown>)['environmentVariableCollection'];
    const terminalEnvManager = isEnvironmentVariableCollection(envCollection)
        ? new TerminalEnvConfigManager(envCollection)
        : undefined;
    const config = vscode.workspace.getConfiguration('otakProxy');
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
        services.terminalEnvManager
    );

    initializer = new ExtensionInitializer({
        extensionContext: context,
        proxyStateManager,
        proxyApplier,
        systemProxyDetector: services.systemProxyDetector,
        userNotifier: services.userNotifier,
        sanitizer: services.sanitizer,
        proxyChangeLogger: services.proxyChangeLogger
    });

    proxyMonitor = initializer.initializeProxyMonitor();
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
        await proxyApplier.applyProxy(activeUrl, true, { silent: true });
    } else if (localState.mode === ProxyMode.Off) {
        await proxyApplier.disableProxy({ silent: true });
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
            if (syncManager && syncConfigManager?.isSyncEnabled()) {
                await syncManager.notifyChange(s);
            }
        },
        getActiveProxyUrl: (s) => proxyStateManager.getActiveProxyUrl(s),
        getNextMode: (mode) => proxyStateManager.getNextMode(mode),
        applyProxySettings: (url, enabled) => proxyApplier.applyProxy(url, enabled, { showProgress: true }),
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

async function applyStartupProxyState(state: ProxyState, terminalEnvManager?: TerminalEnvConfigManager): Promise<void> {
    const activeUrl = proxyStateManager.getActiveProxyUrl(state);

    if (state.mode === ProxyMode.Off) {
        await clearManagedStartupProxyState(state, terminalEnvManager);
        return;
    }

    if (activeUrl) {
        await proxyApplier.applyProxy(activeUrl, true);
    }
}

async function clearManagedStartupProxyState(
    state: ProxyState,
    terminalEnvManager?: TerminalEnvConfigManager
): Promise<void> {
    if (terminalEnvManager) {
        await terminalEnvManager.unsetProxy();
    }

    if (state.gitConfigured || state.vscodeConfigured || state.npmConfigured) {
        await proxyApplier.disableProxy({ silent: true });
    }
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
export async function performInitialSetup(context: vscode.ExtensionContext): Promise<void> {
    try {
        const hasSetup = context.globalState.get('hasInitialSetup', false);
        if (!hasSetup) {
            // If initializer is not initialized (e.g., in tests), skip setup
            if (initializer) {
                await initializer.askForInitialSetup();
            }
            await context.globalState.update('hasInitialSetup', true);
        }
    } catch (error) {
        Logger.error('Initial setup failed:', error);
        // Continue with default state - don't throw
    }
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
    await performInitialSetup(context);
    state = await proxyStateManager.getState();
    state = await startSyncAndLoadSharedState(state);

    await applyStartupProxyState(state, services.terminalEnvManager);
    await updateMonitoringForState(state);
    await publishStartupSyncState(state);
    registerAutoTestConfigListener(context);
}

/**
 * Deactivate the extension
 * Clean up resources
 */
export async function deactivate(): Promise<void> {
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
