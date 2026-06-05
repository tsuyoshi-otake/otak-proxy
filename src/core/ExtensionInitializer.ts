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
import { ProxyMode, ProxyState } from './types';
import { ProxyMonitor, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { Logger } from '../utils/Logger';
import { TestResult } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { InitialSetupFlow } from './InitialSetupFlow';
import { SystemProxyUpdateService } from './SystemProxyUpdateService';
import {
    handleProxyChanged,
    handleProxyStateChanged,
    handleProxyTestComplete,
    StartupTestState
} from './ExtensionProxyEventHandlers';

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
    private startupTestState: StartupTestState = { isPending: false };

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
            await handleProxyChanged(this.context, result);
        });

        // Feature: auto-mode-proxy-testing - Handle test complete events
        this.proxyMonitor.on('proxyTestComplete', async (testResult: TestResult) => {
            await handleProxyTestComplete(this.context, this.startupTestState, testResult);
        });

        // Feature: auto-mode-proxy-testing - Handle state changes based on reachability
        this.proxyMonitor.on('proxyStateChanged', async (data: { proxyUrl: string; reachable: boolean; previousState: boolean }) => {
            await handleProxyStateChanged(this.context, data);
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
        this.startupTestState.isPending = true;
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
        return this.startupTestState.isPending;
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
