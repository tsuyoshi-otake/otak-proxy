/**
 * @file ExtensionInitializer
 * @description Handles extension initialization logic
 *
 * Requirements:
 * - 1.1: Modular initialization
 * - 1.2: Simplified extension.ts
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from './types';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyApplier } from './ProxyApplier';
import { ProxyMonitor, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { UserNotifier } from '../errors/UserNotifier';
import { InputSanitizer } from '../validation/InputSanitizer';
import { Logger } from '../utils/Logger';
import { I18nManager } from '../i18n/I18nManager';
import { validateProxyUrl, detectSystemProxySettings } from '../utils/ProxyUtils';

/**
 * Context for extension initialization
 */
export interface InitializerContext {
    extensionContext: vscode.ExtensionContext;
    proxyStateManager: ProxyStateManager;
    proxyApplier: ProxyApplier;
    systemProxyDetector: SystemProxyDetector;
    userNotifier: UserNotifier;
    sanitizer: InputSanitizer;
    proxyChangeLogger: ProxyChangeLogger;
}

/**
 * ExtensionInitializer handles initialization logic
 */
export class ExtensionInitializer {
    private context: InitializerContext;
    private proxyMonitor: ProxyMonitor | null = null;
    private systemProxyCheckInterval: NodeJS.Timeout | undefined;

    constructor(context: InitializerContext) {
        this.context = context;
    }

    /**
     * Initialize ProxyMonitor with configuration from settings
     */
    initializeProxyMonitor(): ProxyMonitor {
        const config = vscode.workspace.getConfiguration('otakProxy');
        const pollingInterval = config.get<number>('pollingInterval', 30);
        const maxRetries = config.get<number>('maxRetries', 3);
        const priority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);

        // Update SystemProxyDetector priority
        this.context.systemProxyDetector.updateDetectionPriority(priority);

        // Create ProxyMonitor with configuration
        this.proxyMonitor = new ProxyMonitor(
            this.context.systemProxyDetector,
            this.context.proxyChangeLogger,
            {
                pollingInterval: pollingInterval * 1000, // Convert seconds to ms
                debounceDelay: 1000, // 1 second debounce
                maxRetries: maxRetries,
                retryBackoffBase: 1, // 1 second base
                detectionSourcePriority: priority
            }
        );

        // Set up proxyChanged event handler
        this.proxyMonitor.on('proxyChanged', async (result: ProxyDetectionResult) => {
            await this.handleProxyChanged(result);
        });

        // Set up allRetriesFailed event handler
        this.proxyMonitor.on('allRetriesFailed', (data: { error: string; trigger: string }) => {
            Logger.error(`All proxy detection retries failed: ${data.error}`);
            this.context.userNotifier.showWarning(
                'System proxy detection failed after multiple retries. Check your system/browser proxy settings.'
            );
        });

        return this.proxyMonitor;
    }

    /**
     * Get the initialized ProxyMonitor instance
     */
    getProxyMonitor(): ProxyMonitor | null {
        return this.proxyMonitor;
    }

    /**
     * Handle proxy changed event
     */
    private async handleProxyChanged(result: ProxyDetectionResult): Promise<void> {
        const state = await this.context.proxyStateManager.getState();
        if (state.mode === ProxyMode.Auto) {
            const previousProxy = state.autoProxyUrl;
            state.autoProxyUrl = result.proxyUrl || undefined;

            if (previousProxy !== state.autoProxyUrl) {
                await this.context.proxyStateManager.saveState(state);
                await this.context.proxyApplier.applyProxy(state.autoProxyUrl || '', true);

                if (state.autoProxyUrl) {
                    this.context.userNotifier.showSuccess(
                        'message.systemProxyChanged',
                        { url: this.context.sanitizer.maskPassword(state.autoProxyUrl) }
                    );
                } else if (previousProxy) {
                    this.context.userNotifier.showSuccess('message.systemProxyRemoved');
                }
            }
        }
    }

    /**
     * Start system proxy monitoring
     */
    async startSystemProxyMonitoring(): Promise<void> {
        // Check system proxy immediately using legacy method
        await this.checkAndUpdateSystemProxy();

        // Stop any existing legacy interval
        if (this.systemProxyCheckInterval) {
            clearInterval(this.systemProxyCheckInterval);
            this.systemProxyCheckInterval = undefined;
        }

        // Start ProxyMonitor for polling-based checks
        if (this.proxyMonitor && !this.proxyMonitor.getState().isActive) {
            this.proxyMonitor.start();
            Logger.info('ProxyMonitor started for Auto mode');
        }
    }

    /**
     * Stop system proxy monitoring
     */
    async stopSystemProxyMonitoring(): Promise<void> {
        // Stop legacy interval if running
        if (this.systemProxyCheckInterval) {
            clearInterval(this.systemProxyCheckInterval);
            this.systemProxyCheckInterval = undefined;
        }

        // Stop ProxyMonitor
        if (this.proxyMonitor && this.proxyMonitor.getState().isActive) {
            this.proxyMonitor.stop();
            Logger.info('ProxyMonitor stopped');
        }
    }

    /**
     * Check and update system proxy
     */
    private async checkAndUpdateSystemProxy(): Promise<void> {
        const state = await this.context.proxyStateManager.getState();

        // Only check if in Auto mode or if it's been more than 5 minutes since last check
        const now = Date.now();
        if (state.mode !== ProxyMode.Auto &&
            state.lastSystemProxyCheck &&
            (now - state.lastSystemProxyCheck) < 300000) {
            return;
        }

        const detectedProxy = await detectSystemProxySettings();
        state.lastSystemProxyCheck = now;
        
        // Track system proxy detection success/failure
        state.systemProxyDetected = !!detectedProxy;

        if (state.mode === ProxyMode.Auto) {
            const previousProxy = state.autoProxyUrl;
            state.autoProxyUrl = detectedProxy || undefined;

            if (previousProxy !== state.autoProxyUrl) {
                // System proxy changed, update everything
                await this.context.proxyStateManager.saveState(state);
                await this.context.proxyApplier.applyProxy(state.autoProxyUrl || '', true);

                if (state.autoProxyUrl) {
                    this.context.userNotifier.showSuccess(
                        'message.systemProxyChanged',
                        { url: this.context.sanitizer.maskPassword(state.autoProxyUrl) }
                    );
                } else if (previousProxy) {
                    this.context.userNotifier.showSuccess('message.systemProxyRemoved');
                }
            }
        } else {
            // Just save the detected proxy for later use
            state.autoProxyUrl = detectedProxy || undefined;
            await this.context.proxyStateManager.saveState(state);
        }
    }

    /**
     * Ask for initial setup
     */
    async askForInitialSetup(): Promise<void> {
        const state = await this.context.proxyStateManager.getState();
        const i18n = I18nManager.getInstance();

        // First, ask what mode to use
        const modeAnswer = await vscode.window.showInformationMessage(
            i18n.t('prompt.initialSetup'),
            i18n.t('action.autoSystem'),
            i18n.t('action.manualSetup'),
            i18n.t('action.skip')
        );

        if (modeAnswer === i18n.t('action.autoSystem')) {
            await this.handleAutoSetup(state, i18n);
        } else if (modeAnswer === i18n.t('action.manualSetup')) {
            await this.handleManualSetup(state, i18n);
        }

        // Start monitoring if in auto mode
        if (state.mode === ProxyMode.Auto) {
            await this.startSystemProxyMonitoring();
        }
    }

    /**
     * Handle auto setup
     */
    private async handleAutoSetup(state: ProxyState, i18n: I18nManager): Promise<void> {
        // Try to detect system proxy settings
        const detectedProxy = await detectSystemProxySettings();

        if (detectedProxy && validateProxyUrl(detectedProxy)) {
            state.autoProxyUrl = detectedProxy;
            state.mode = ProxyMode.Auto;
            await this.context.proxyStateManager.saveState(state);
            await this.context.proxyApplier.applyProxy(detectedProxy, true);
            this.context.userNotifier.showSuccess(
                'message.usingSystemProxy',
                { url: this.context.sanitizer.maskPassword(detectedProxy) }
            );
        } else {
            const fallback = await vscode.window.showInformationMessage(
                i18n.t('prompt.couldNotDetect'),
                i18n.t('action.yes'),
                i18n.t('action.no')
            );

            if (fallback === i18n.t('action.yes')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
                const updatedState = await this.context.proxyStateManager.getState();
                if (updatedState.manualProxyUrl) {
                    updatedState.mode = ProxyMode.Manual;
                    await this.context.proxyStateManager.saveState(updatedState);
                    await this.context.proxyApplier.applyProxy(updatedState.manualProxyUrl, true);
                }
            }
        }
    }

    /**
     * Handle manual setup
     */
    private async handleManualSetup(state: ProxyState, i18n: I18nManager): Promise<void> {
        const manualProxyUrl = await vscode.window.showInputBox({
            prompt: i18n.t('prompt.proxyUrl'),
            placeHolder: i18n.t('prompt.proxyUrlPlaceholder')
        });

        if (manualProxyUrl) {
            if (!validateProxyUrl(manualProxyUrl)) {
                this.context.userNotifier.showError(
                    'error.invalidProxyUrl',
                    [
                        'suggestion.useFormat',
                        'suggestion.includeProtocol',
                        'suggestion.validHostname'
                    ]
                );
                return;
            }
            state.manualProxyUrl = manualProxyUrl;
            state.mode = ProxyMode.Manual;
            await this.context.proxyStateManager.saveState(state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update(
                'proxyUrl',
                manualProxyUrl,
                vscode.ConfigurationTarget.Global
            );

            await this.context.proxyApplier.applyProxy(manualProxyUrl, true);
            this.context.userNotifier.showSuccess(
                'message.manualProxyConfigured',
                { url: this.context.sanitizer.maskPassword(manualProxyUrl) }
            );
        }
    }
}
