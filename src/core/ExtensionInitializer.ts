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
import { ProxyMonitor, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { Logger } from '../utils/Logger';
import { TestResult } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { InitialSetupFlow } from './InitialSetupFlow';
import { SystemProxyUpdateService } from './SystemProxyUpdateService';

export type { InitializerContext } from './ExtensionInitializerTypes';

/**
 * ExtensionInitializer handles initialization logic
 * Feature: auto-mode-proxy-testing
 */
export class ExtensionInitializer {
    private context: InitializerContext;
    private proxyMonitor: ProxyMonitor | null = null;
    private connectionTester: ProxyConnectionTester | null = null;
    private initialSetupFlow: InitialSetupFlow;
    private systemProxyUpdateService: SystemProxyUpdateService;
    private systemProxyCheckInterval: NodeJS.Timeout | undefined;
    private isStartupTestPending: boolean = false;

    private autoTestEnabled: boolean = true;

    constructor(context: InitializerContext) {
        this.context = context;
        // Initialize connection tester for startup and Auto mode testing
        this.connectionTester = new ProxyConnectionTester(this.context.userNotifier);
        this.initialSetupFlow = new InitialSetupFlow(
            this.context,
            () => this.startSystemProxyMonitoring()
        );
        this.systemProxyUpdateService = new SystemProxyUpdateService(
            this.context,
            () => this.connectionTester
        );
    }

    /**
     * Set the status bar update callback
     * Called after StatusBarManager is initialized
     */
    setStatusBarUpdater(updater: (state: ProxyState) => void): void {
        this.context.updateStatusBar = updater;
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
                'warning.detectionFailedRetries'
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

        // Only process for Auto mode
        if (state.mode !== ProxyMode.Auto) {
            return;
        }

        // Update state with test result
        state.lastTestResult = testResult as ProxyTestResult;
        state.proxyReachable = testResult.success;
        state.lastTestTimestamp = Date.now();

        // Update autoModeOff based on test result
        if (!testResult.success) {
            // Test failed - set Auto Mode OFF
            state.autoModeOff = true;
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            Logger.info('Proxy test failed - Auto Mode OFF');
        } else {
            // Test succeeded - ensure Auto Mode is ON
            state.autoModeOff = false;
        }

        await this.context.proxyStateManager.saveState(state);

        // Update status bar
        if (this.context.updateStatusBar) {
            this.context.updateStatusBar(state);
        }

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

        // Apply proxy settings based on new reachability state.
        // Use silent mode because these are automatic monitor-driven transitions,
        // not explicit user actions.
        if (data.reachable && !data.previousState) {
            // Proxy became reachable
            state.autoModeOff = false;
            await this.context.proxyApplier.applyProxy(data.proxyUrl, true, { silent: true });
            Logger.info(`Proxy ${data.proxyUrl} became reachable, enabling proxy`);
        } else if (!data.reachable && data.previousState) {
            // Proxy became unreachable - set Auto Mode OFF
            state.autoModeOff = true;
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            await this.context.proxyApplier.applyProxy(data.proxyUrl, false, { silent: true });
            Logger.info(`Proxy ${data.proxyUrl} became unreachable, Auto Mode OFF`);
        }

        await this.context.proxyStateManager.saveState(state);
        if (this.context.updateStatusBar) {
            this.context.updateStatusBar(state);
        }
    }

    /**
     * Start system proxy monitoring
     * Feature: auto-mode-proxy-testing - Runs startup connection test
     */
    async startSystemProxyMonitoring(): Promise<void> {
        const state = await this.context.proxyStateManager.getState();

        // Monitoring is only meaningful in Auto mode. In other modes, ensure it's stopped.
        if (state.mode !== ProxyMode.Auto) {
            await this.stopSystemProxyMonitoring();
            return;
        }

        // If already running, don't reset startup flags or redo expensive work.
        if (this.proxyMonitor?.getState().isActive) {
            return;
        }

        // Feature: auto-mode-proxy-testing - Mark state as testing pending
        this.isStartupTestPending = true;
        state.proxyReachable = undefined; // Indeterminate until test completes
        await this.context.proxyStateManager.saveState(state);

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
    async checkAndUpdateSystemProxy(): Promise<void> {
        await this.systemProxyUpdateService.checkAndUpdateSystemProxy();
    }

    /**
     * Ask for initial setup
     */
    async askForInitialSetup(): Promise<void> {
        await this.initialSetupFlow.askForInitialSetup();
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
