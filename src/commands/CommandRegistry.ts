/**
 * @file CommandRegistry
 * @description Centralized command registration and management
 *
 * Requirements:
 * - 1.1, 5.1: Commands must be registered before status bar display
 * - 2.2: Unified command registration
 * - 2.3: Error handling consistency
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { Logger } from '../utils/Logger';
import { CommandContext } from './types';
import { executeToggleProxy } from './ToggleProxyCommand';
import { executeConfigureUrl } from './ConfigureUrlCommand';
import { executeTestProxy } from './TestProxyCommand';
import { executeImportProxy } from './ImportProxyCommand';

/**
 * Configuration for CommandRegistry
 */
export interface CommandRegistryConfig {
    // Extension context
    context: vscode.ExtensionContext;

    // State management functions
    getProxyState: (context: vscode.ExtensionContext) => Promise<ProxyState>;
    saveProxyState: (context: vscode.ExtensionContext, state: ProxyState) => Promise<void>;
    getActiveProxyUrl: (state: ProxyState) => string;
    getNextMode: (currentMode: ProxyMode) => ProxyMode;

    // Proxy operations
    applyProxySettings: (url: string, enabled: boolean, context?: vscode.ExtensionContext) => Promise<boolean>;
    updateStatusBar: (state: ProxyState) => void;
    checkAndUpdateSystemProxy: (context: vscode.ExtensionContext) => Promise<void>;
    startSystemProxyMonitoring: (context: vscode.ExtensionContext) => Promise<void>;

    // Utilities
    userNotifier: {
        showSuccess: (key: string, params?: Record<string, string>) => void;
        showWarning: (key: string, params?: Record<string, string>) => void;
        showError: (key: string, suggestions?: string[]) => void;
    };
    sanitizer: {
        maskPassword: (url: string) => string;
    };

    // ProxyMonitor and SystemProxyDetector for config change handling
    proxyMonitor: {
        updateConfig: (config: any) => void;
        triggerCheck: (source: 'config' | 'network' | 'polling' | 'focus') => void;
    };
    systemProxyDetector: {
        updateDetectionPriority: (priority: string[]) => void;
    };
}

/**
 * CommandRegistry handles registration of all extension commands
 */
export class CommandRegistry {
    private config: CommandRegistryConfig;
    private commandContext: CommandContext;

    constructor(config: CommandRegistryConfig) {
        this.config = config;
        this.commandContext = this.createCommandContext();
    }

    /**
     * Create command context from config
     */
    private createCommandContext(): CommandContext {
        const { context } = this.config;
        return {
            extensionContext: context,
            getProxyState: () => this.config.getProxyState(context),
            saveProxyState: (state) => this.config.saveProxyState(context, state),
            getActiveProxyUrl: this.config.getActiveProxyUrl,
            getNextMode: this.config.getNextMode,
            applyProxySettings: (url, enabled) => this.config.applyProxySettings(url, enabled, context),
            updateStatusBar: this.config.updateStatusBar,
            checkAndUpdateSystemProxy: () => this.config.checkAndUpdateSystemProxy(context),
            startSystemProxyMonitoring: () => this.config.startSystemProxyMonitoring(context),
            userNotifier: this.config.userNotifier,
            sanitizer: this.config.sanitizer
        };
    }

    /**
     * Register all commands
     * Requirement 1.1, 5.1: All commands must be registered before status bar display
     */
    registerAll(): void {
        const { context } = this.config;

        // Register main commands
        this.registerToggleProxy(context);
        this.registerConfigureUrl(context);
        this.registerTestProxy(context);
        this.registerImportProxy(context);

        // Register listeners
        this.registerConfigChangeListener(context);
        this.registerWindowFocusListener(context);
    }

    /**
     * Register toggle proxy command
     */
    private registerToggleProxy(context: vscode.ExtensionContext): void {
        const disposable = vscode.commands.registerCommand(
            'otak-proxy.toggleProxy',
            async () => executeToggleProxy(this.commandContext)
        );
        context.subscriptions.push(disposable);
    }

    /**
     * Register configure URL command
     */
    private registerConfigureUrl(context: vscode.ExtensionContext): void {
        const disposable = vscode.commands.registerCommand(
            'otak-proxy.configureUrl',
            async () => executeConfigureUrl(this.commandContext)
        );
        context.subscriptions.push(disposable);
    }

    /**
     * Register test proxy command
     */
    private registerTestProxy(context: vscode.ExtensionContext): void {
        const disposable = vscode.commands.registerCommand(
            'otak-proxy.testProxy',
            async () => executeTestProxy(this.commandContext)
        );
        context.subscriptions.push(disposable);
    }

    /**
     * Register import proxy command
     */
    private registerImportProxy(context: vscode.ExtensionContext): void {
        const disposable = vscode.commands.registerCommand(
            'otak-proxy.importProxy',
            async () => executeImportProxy(this.commandContext)
        );
        context.subscriptions.push(disposable);
    }

    /**
     * Register configuration change listener
     */
    private registerConfigChangeListener(context: vscode.ExtensionContext): void {
        const disposable = vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('otakProxy.proxyUrl')) {
                await this.handleProxyUrlChange();
            }

            if (e.affectsConfiguration('otakProxy.pollingInterval')) {
                this.handlePollingIntervalChange();
            }

            if (e.affectsConfiguration('otakProxy.detectionSourcePriority')) {
                this.handleDetectionPriorityChange();
            }

            if (e.affectsConfiguration('otakProxy.maxRetries')) {
                this.handleMaxRetriesChange();
            }
        });
        context.subscriptions.push(disposable);
    }

    /**
     * Handle proxy URL configuration change
     */
    private async handleProxyUrlChange(): Promise<void> {
        const state = await this.commandContext.getProxyState();
        const newUrl = vscode.workspace.getConfiguration('otakProxy').get<string>('proxyUrl', '');

        if (newUrl !== state.manualProxyUrl) {
            state.manualProxyUrl = newUrl;
            await this.commandContext.saveProxyState(state);

            if (state.mode === ProxyMode.Manual) {
                await this.commandContext.applyProxySettings(newUrl, !!newUrl);
                this.commandContext.updateStatusBar(state);
            }
        }
    }

    /**
     * Handle polling interval change
     */
    private handlePollingIntervalChange(): void {
        const newInterval = vscode.workspace
            .getConfiguration('otakProxy')
            .get<number>('pollingInterval', 30);
        this.config.proxyMonitor.updateConfig({
            pollingInterval: newInterval * 1000
        });
        Logger.info(`Polling interval updated to ${newInterval} seconds`);
    }

    /**
     * Handle detection source priority change
     */
    private handleDetectionPriorityChange(): void {
        const newPriority = vscode.workspace
            .getConfiguration('otakProxy')
            .get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
        this.config.systemProxyDetector.updateDetectionPriority(newPriority);
        this.config.proxyMonitor.updateConfig({
            detectionSourcePriority: newPriority
        });
        Logger.info(`Detection source priority updated to: ${newPriority.join(', ')}`);
    }

    /**
     * Handle max retries change
     */
    private handleMaxRetriesChange(): void {
        const newMaxRetries = vscode.workspace
            .getConfiguration('otakProxy')
            .get<number>('maxRetries', 3);
        this.config.proxyMonitor.updateConfig({
            maxRetries: newMaxRetries
        });
        Logger.info(`Max retries updated to ${newMaxRetries}`);
    }

    /**
     * Register window focus listener
     */
    private registerWindowFocusListener(context: vscode.ExtensionContext): void {
        const disposable = vscode.window.onDidChangeWindowState(async (windowState) => {
            if (windowState.focused) {
                const state = await this.commandContext.getProxyState();
                if (state.mode === ProxyMode.Auto) {
                    this.config.proxyMonitor.triggerCheck('focus');
                }
            }
        });
        context.subscriptions.push(disposable);
    }
}

/**
 * Create and register all commands
 * This is a convenience function for backward compatibility
 */
export function createCommandRegistry(config: CommandRegistryConfig): CommandRegistry {
    const registry = new CommandRegistry(config);
    registry.registerAll();
    return registry;
}
