/**
 * @file ExtensionInitializer
 * @description Handles extension initialization logic
 *
 * Requirements:
 * - 1.1: Modular initialization
 * - 1.2: Simplified extension.ts
 * Feature: auto-mode-proxy-testing
 * - 4.1: Startup connection test execution
 * - 4.2: Enable proxy on successful test
 * - 4.3: Disable proxy on failed test
 * - 4.4: Handle indeterminate state until test completes
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState, ProxyTestResult } from './types';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyApplier } from './ProxyApplier';
import { ProxyMonitor, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { UserNotifier } from '../errors/UserNotifier';
import { InputSanitizer } from '../validation/InputSanitizer';
import { Logger } from '../utils/Logger';
import { I18nManager } from '../i18n/I18nManager';
import { validateProxyUrl, detectSystemProxySettings, TestResult } from '../utils/ProxyUtils';

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
 * Feature: auto-mode-proxy-testing
 */
export class ExtensionInitializer {
    private context: InitializerContext;
    private proxyMonitor: ProxyMonitor | null = null;
    private connectionTester: ProxyConnectionTester | null = null;
    private systemProxyCheckInterval: NodeJS.Timeout | undefined;
    private isStartupTestPending: boolean = false;

    private autoTestEnabled: boolean = true;

    constructor(context: InitializerContext) {
        this.context = context;
        // Initialize connection tester for startup and Auto mode testing
        this.connectionTester = new ProxyConnectionTester(this.context.userNotifier);
    }

    /**
     * Initialize ProxyMonitor with configuration from settings
     * Feature: auto-mode-proxy-testing - Integrates connection testing
     */
    initializeProxyMonitor(): ProxyMonitor {
        const config = vscode.workspace.getConfiguration('otakProxy');
        const pollingInterval = config.get<number>('pollingInterval', 30);
        const maxRetries = config.get<number>('maxRetries', 3);
        const priority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
        const enableConnectionTest = config.get<boolean>('autoTestEnabled', true);
        const connectionTestInterval = config.get<number>('testInterval', 60) * 1000; // Convert to ms

        // Update SystemProxyDetector priority
        this.context.systemProxyDetector.updateDetectionPriority(priority);

        // Create ProxyMonitor with configuration and connection tester
        this.proxyMonitor = new ProxyMonitor(
            this.context.systemProxyDetector,
            this.context.proxyChangeLogger,
            {
                pollingInterval: pollingInterval * 1000, // Convert seconds to ms
                debounceDelay: 1000, // 1 second debounce
                maxRetries: maxRetries,
                retryBackoffBase: 1, // 1 second base
                detectionSourcePriority: priority,
                enableConnectionTest: enableConnectionTest,
                connectionTestInterval: connectionTestInterval
            },
            this.connectionTester || undefined
        );

        // Set up proxyChanged event handler
        this.proxyMonitor.on('proxyChanged', async (result: ProxyDetectionResult) => {
            await this.handleProxyChanged(result);
        });

        // Feature: auto-mode-proxy-testing - Handle test complete events
        this.proxyMonitor.on('proxyTestComplete', async (testResult: TestResult) => {
            await this.handleProxyTestComplete(testResult);
        });

        // Feature: auto-mode-proxy-testing - Handle state changes based on reachability
        this.proxyMonitor.on('proxyStateChanged', async (data: { proxyUrl: string; reachable: boolean; previousState: boolean }) => {
            await this.handleProxyStateChanged(data);
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
     * Feature: auto-mode-proxy-testing - Updated to consider proxy reachability
     */
    private async handleProxyChanged(result: ProxyDetectionResult): Promise<void> {
        const state = await this.context.proxyStateManager.getState();
        if (state.mode === ProxyMode.Auto) {
            const previousProxy = state.autoProxyUrl;
            state.autoProxyUrl = result.proxyUrl || undefined;

            // Feature: auto-mode-proxy-testing - Update reachability state
            if (result.testResult) {
                state.lastTestResult = result.testResult as ProxyTestResult;
                state.proxyReachable = result.proxyReachable;
                state.lastTestTimestamp = Date.now();
            }

            if (previousProxy !== state.autoProxyUrl) {
                await this.context.proxyStateManager.saveState(state);

                // Feature: auto-mode-proxy-testing - Only apply proxy if it's reachable
                const shouldEnable = Boolean(state.autoProxyUrl && (result.proxyReachable !== false));
                await this.context.proxyApplier.applyProxy(state.autoProxyUrl || '', shouldEnable);

                if (state.autoProxyUrl && result.proxyReachable !== false) {
                    this.context.userNotifier.showSuccess(
                        'message.systemProxyChanged',
                        { url: this.context.sanitizer.maskPassword(state.autoProxyUrl) }
                    );
                } else if (previousProxy && !state.autoProxyUrl) {
                    this.context.userNotifier.showSuccess('message.systemProxyRemoved');
                }
            } else {
                // Same proxy URL but need to save test result
                await this.context.proxyStateManager.saveState(state);
            }
        }
    }

    /**
     * Handle proxy test complete event
     * Feature: auto-mode-proxy-testing
     */
    private async handleProxyTestComplete(testResult: TestResult): Promise<void> {
        const state = await this.context.proxyStateManager.getState();

        // Update state with test result
        state.lastTestResult = testResult as ProxyTestResult;
        state.proxyReachable = testResult.success;
        state.lastTestTimestamp = Date.now();

        await this.context.proxyStateManager.saveState(state);

        // Clear startup test pending flag if applicable
        if (this.isStartupTestPending) {
            this.isStartupTestPending = false;
            Logger.info(`Startup connection test completed: ${testResult.success ? 'success' : 'failed'}`);
        }
    }

    /**
     * Handle proxy state changed event (reachability change)
     * Feature: auto-mode-proxy-testing
     */
    private async handleProxyStateChanged(data: { proxyUrl: string; reachable: boolean; previousState: boolean }): Promise<void> {
        const state = await this.context.proxyStateManager.getState();

        if (state.mode !== ProxyMode.Auto) {
            return;
        }

        state.proxyReachable = data.reachable;
        await this.context.proxyStateManager.saveState(state);

        // Apply proxy settings based on new reachability state
        if (data.reachable && !data.previousState) {
            // Proxy became reachable
            await this.context.proxyApplier.applyProxy(data.proxyUrl, true);
            Logger.info(`Proxy ${data.proxyUrl} became reachable, enabling proxy`);
        } else if (!data.reachable && data.previousState) {
            // Proxy became unreachable
            await this.context.proxyApplier.applyProxy(data.proxyUrl, false);
            Logger.info(`Proxy ${data.proxyUrl} became unreachable, disabling proxy`);
        }
    }

    /**
     * Start system proxy monitoring
     * Feature: auto-mode-proxy-testing - Runs startup connection test
     */
    async startSystemProxyMonitoring(): Promise<void> {
        const state = await this.context.proxyStateManager.getState();

        // Feature: auto-mode-proxy-testing - Mark state as testing pending
        if (state.mode === ProxyMode.Auto) {
            this.isStartupTestPending = true;
            state.proxyReachable = undefined; // Indeterminate until test completes
            await this.context.proxyStateManager.saveState(state);
        }

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

            // Feature: auto-mode-proxy-testing - Trigger immediate connection test at startup
            if (state.mode === ProxyMode.Auto && state.autoProxyUrl) {
                Logger.info('Triggering startup connection test');
                this.proxyMonitor.triggerCheck('config');
            }
        }
    }

    /**
     * Run a manual connection test
     * Feature: auto-mode-proxy-testing
     */
    async runManualConnectionTest(): Promise<TestResult | undefined> {
        if (this.proxyMonitor) {
            return this.proxyMonitor.triggerConnectionTest();
        }
        return undefined;
    }

    /**
     * Check if startup test is still pending
     * Feature: auto-mode-proxy-testing
     */
    isStartupTestStillPending(): boolean {
        return this.isStartupTestPending;
    }

    /**
     * Get the connection tester instance
     * Feature: auto-mode-proxy-testing
     */
    getConnectionTester(): ProxyConnectionTester | null {
        return this.connectionTester;
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

    /**
     * Handle configuration changes for proxy testing settings
     * Feature: auto-mode-proxy-testing (Task 7.2)
     *
     * @param key - The configuration key that changed
     * @param value - The new value
     *
     * Requirements:
     * - 8.2: Apply new test interval immediately
     * - 8.4: Apply autoTestEnabled changes immediately
     */
    handleConfigurationChange(key: string, value: number | boolean | string): void {
        if (!this.proxyMonitor) {
            return;
        }

        switch (key) {
            case 'testInterval': {
                // Convert seconds to milliseconds and clamp to valid range
                const intervalSeconds = typeof value === 'number' ? value : 60;
                const clampedSeconds = Math.max(30, Math.min(600, intervalSeconds));
                const intervalMs = clampedSeconds * 1000;

                // Update ProxyMonitor's connection test interval
                this.proxyMonitor.updateConfig({
                    connectionTestInterval: intervalMs
                });

                Logger.info(`Test interval updated to ${clampedSeconds} seconds`);
                break;
            }

            case 'autoTestEnabled': {
                const enabled = typeof value === 'boolean' ? value : true;
                this.autoTestEnabled = enabled;

                // Update ProxyMonitor's connection test enabled state
                this.proxyMonitor.updateConfig({
                    enableConnectionTest: enabled
                });

                if (enabled) {
                    Logger.info('Auto connection testing enabled');
                } else {
                    Logger.info('Auto connection testing disabled');
                }
                break;
            }

            default:
                // Ignore other configuration changes
                break;
        }
    }
}
