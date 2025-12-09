/**
 * @file extension.ts
 * @description Main entry point for the otak-proxy extension
 *
 * Requirements:
 * - 1.1: Simplified extension entry point
 * - 1.2: Modular architecture
 */

import * as vscode from 'vscode';
import { ProxyMode } from './core/types';
import { ProxyStateManager } from './core/ProxyStateManager';
import { ProxyApplier } from './core/ProxyApplier';
import { ExtensionInitializer } from './core/ExtensionInitializer';
import { ProxyUrlValidator } from './validation/ProxyUrlValidator';
import { InputSanitizer } from './validation/InputSanitizer';
import { GitConfigManager } from './config/GitConfigManager';
import { VscodeConfigManager } from './config/VscodeConfigManager';
import { NpmConfigManager } from './config/NpmConfigManager';
import { SystemProxyDetector } from './config/SystemProxyDetector';
import { UserNotifier } from './errors/UserNotifier';
import { Logger } from './utils/Logger';
import { ProxyMonitor } from './monitoring/ProxyMonitor';
import { ProxyChangeLogger } from './monitoring/ProxyChangeLogger';
import { I18nManager } from './i18n/I18nManager';
import { StatusBarManager } from './ui/StatusBarManager';
import { createCommandRegistry } from './commands/CommandRegistry';

// Module-level instances
let proxyStateManager: ProxyStateManager;
let proxyApplier: ProxyApplier;
let statusBarManager: StatusBarManager;
let initializer: ExtensionInitializer;
let proxyMonitor: ProxyMonitor;

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
export async function activate(context: vscode.ExtensionContext) {
    Logger.log('Extension "otak-proxy" is now active.');

    // Phase 0: Initialize I18n
    const i18n = I18nManager.getInstance();
    i18n.initialize();
    Logger.log(`I18n initialized with locale: ${i18n.getCurrentLocale()}`);

    // Phase 1: Initialize core components
    const validator = new ProxyUrlValidator();
    const sanitizer = new InputSanitizer();
    const gitConfigManager = new GitConfigManager();
    const vscodeConfigManager = new VscodeConfigManager();
    const npmConfigManager = new NpmConfigManager();
    const userNotifier = new UserNotifier();
    const proxyChangeLogger = new ProxyChangeLogger(sanitizer);

    // Initialize configuration from settings
    const config = vscode.workspace.getConfiguration('otakProxy');
    const detectionSourcePriority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
    const systemProxyDetector = new SystemProxyDetector(detectionSourcePriority);

    // Phase 2: Initialize managers
    proxyStateManager = new ProxyStateManager(context);
    proxyApplier = new ProxyApplier(
        gitConfigManager,
        vscodeConfigManager,
        npmConfigManager,
        validator,
        sanitizer,
        userNotifier,
        proxyStateManager
    );

    // Phase 3: Initialize ExtensionInitializer
    initializer = new ExtensionInitializer({
        extensionContext: context,
        proxyStateManager,
        proxyApplier,
        systemProxyDetector,
        userNotifier,
        sanitizer,
        proxyChangeLogger
    });

    // Phase 4: Initialize ProxyMonitor
    proxyMonitor = initializer.initializeProxyMonitor();

    // Phase 5: Initialize StatusBar
    statusBarManager = new StatusBarManager(context);
    statusBarManager.setMonitorProviders(proxyMonitor, proxyChangeLogger);
    initializer.setStatusBarUpdater((s) => statusBarManager.update(s));

    // Phase 6: State initialization
    let state = await proxyStateManager.getState();

    // Migrate manual URL from config if needed
    const configProxyUrl = config.get<string>('proxyUrl', '');
    if (configProxyUrl && !state.manualProxyUrl) {
        state.manualProxyUrl = configProxyUrl;
        await proxyStateManager.saveState(state);
    }

    // Phase 7: Command registration (BEFORE status bar display)
    // Requirement 1.1, 5.1: All commands must be registered before status bar displays command links
    createCommandRegistry({
        context,
        getProxyState: (ctx) => proxyStateManager.getState(),
        saveProxyState: (ctx, s) => proxyStateManager.saveState(s),
        getActiveProxyUrl: (s) => proxyStateManager.getActiveProxyUrl(s),
        getNextMode: (mode) => proxyStateManager.getNextMode(mode),
        applyProxySettings: (url, enabled) => proxyApplier.applyProxy(url, enabled),
        updateStatusBar: (s) => statusBarManager.update(s),
        checkAndUpdateSystemProxy: async () => { /* handled by initializer */ },
        startSystemProxyMonitoring: () => initializer.startSystemProxyMonitoring(),
        userNotifier: {
            showSuccess: (key, params) => userNotifier.showSuccess(key, params),
            showWarning: (key, params) => userNotifier.showWarning(key, params),
            showError: (key, suggestions) => userNotifier.showError(key, suggestions),
            showErrorWithDetails: (message, details, suggestions, params) => 
                userNotifier.showErrorWithDetails(message, details, suggestions, params),
            showProgressNotification: (title, task, cancellable) => 
                userNotifier.showProgressNotification(title, task, cancellable)
        },
        sanitizer,
        proxyMonitor,
        systemProxyDetector
    });

    // Phase 8: UI initialization
    statusBarManager.update(state);

    // Phase 9: Initial setup (after commands are registered)
    await performInitialSetup(context);
    state = await proxyStateManager.getState(); // Reload state after setup

    // Phase 10: Apply current proxy settings
    const activeUrl = proxyStateManager.getActiveProxyUrl(state);
    if (state.mode !== ProxyMode.Off && activeUrl) {
        await proxyApplier.applyProxy(activeUrl, true);
    }

    // Phase 11: Start monitoring
    await initializer.startSystemProxyMonitoring();

    // Phase 12: Register configuration change listener (Task 7.2)
    // Feature: auto-mode-proxy-testing
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        // Check for testInterval change
        if (e.affectsConfiguration('otakProxy.testInterval')) {
            const newInterval = vscode.workspace.getConfiguration('otakProxy').get<number>('testInterval', 60);
            initializer.handleConfigurationChange('testInterval', newInterval);
        }

        // Check for autoTestEnabled change
        if (e.affectsConfiguration('otakProxy.autoTestEnabled')) {
            const enabled = vscode.workspace.getConfiguration('otakProxy').get<boolean>('autoTestEnabled', true);
            initializer.handleConfigurationChange('autoTestEnabled', enabled);
        }
    });

    context.subscriptions.push(configChangeDisposable);
}

/**
 * Deactivate the extension
 * Clean up resources
 */
export async function deactivate() {
    // Stop monitoring
    if (initializer) {
        await initializer.stopSystemProxyMonitoring();
    }
    
    // Stop ProxyMonitor
    if (proxyMonitor) {
        proxyMonitor.stop();
    }
}
