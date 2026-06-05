import { EventEmitter } from 'events';
import { ProxyMonitorState, MonitoringStatus } from './ProxyMonitorState';
import { ProxyChangeLogger, ProxyCheckEvent, ProxyChangeEvent } from './ProxyChangeLogger';
import { Logger } from '../utils/Logger';
import { ProxyConnectionTester } from './ProxyConnectionTester';
import { ProxyTestScheduler } from './ProxyTestScheduler';
import { TestResult } from '../utils/ProxyUtils';
import {
    ISystemProxyDetector,
    ProxyCheckTrigger,
    ProxyDetectionResult,
    ProxyMonitorConfig
} from './ProxyMonitorTypes';
import { DEFAULT_PROXY_MONITOR_CONFIG, normalizeProxyMonitorConfig } from './ProxyMonitorConfig';
import { detectProxyWithRetry } from './ProxyMonitorDetection';

export type { ProxyDetectionResult, ProxyMonitorConfig } from './ProxyMonitorTypes';

/**
 * ProxyMonitor - Manages proxy detection with polling, debouncing, and retry logic
 *
 * This class provides:
 * - Configurable polling interval for automatic detection
 * - Debouncing to prevent excessive checks
 * - Retry logic with exponential backoff
 * - Event emission for proxy changes
 *
 * Requirements covered:
 * - 1.1: Polling at configurable interval
 * - 1.2: Dynamic interval update
 * - 1.4: Stop polling on mode change
 * - 2.4: Debounce processing
 * - 3.1-3.4: Retry logic with exponential backoff
 */
export class ProxyMonitor extends EventEmitter {
    private config: ProxyMonitorConfig;
    private detector: ISystemProxyDetector;
    private logger: ProxyChangeLogger;
    private state: ProxyMonitorState;
    private pollingInterval?: NodeJS.Timeout;
    private debounceTimer?: NodeJS.Timeout;
    private retryCount: number = 0;
    private lastProxyUrl: string | null = null;
    private isCheckInProgress: boolean = false;
    private connectionTester?: ProxyConnectionTester;
    private testScheduler?: ProxyTestScheduler;
    private lastProxyReachable: boolean = false;
    private lastConnectionTestAt: number | null = null;

    constructor(
        detector: ISystemProxyDetector,
        logger: ProxyChangeLogger,
        config?: Partial<ProxyMonitorConfig>,
        connectionTester?: ProxyConnectionTester
    ) {
        super();
        this.detector = detector;
        this.logger = logger;
        this.state = new ProxyMonitorState();
        this.config = { ...DEFAULT_PROXY_MONITOR_CONFIG, ...config };
        this.validateConfig();

        // Set up connection testing if tester provided. Whether we actually run tests is controlled by config.
        if (connectionTester) {
            this.connectionTester = connectionTester;
            this.testScheduler = new ProxyTestScheduler(
                connectionTester,
                this.config.connectionTestInterval
            );
        }
    }

    /**
     * Whether we should run periodic connection tests in a dedicated scheduler.
     *
     * When polling is slower than the desired test interval, a scheduler is needed to
     * test reachability at the configured cadence. Otherwise, polling-triggered checks
     * can drive tests without duplicating work.
     */
    private shouldUseTestScheduler(): boolean {
        return Boolean(
            this.connectionTester &&
            this.testScheduler &&
            this.config.enableConnectionTest &&
            this.config.pollingInterval > this.config.connectionTestInterval
        );
    }

    /**
     * Starts proxy monitoring
     * Sets up polling interval and connection test scheduler
     */
    start(): void {
        if (this.state.getStatus().isActive) {
            return; // Already running
        }

        this.state.setActive(true);
        this.setupPolling();
        Logger.info('ProxyMonitor started');

        // Start connection test scheduler only when needed (polling slower than test interval)
        if (this.shouldUseTestScheduler() && this.lastProxyUrl) {
            this.startConnectionTestScheduler(this.lastProxyUrl);
        }
    }

    /**
     * Stops proxy monitoring
     * Clears all timers and stops scheduler
     */
    stop(): void {
        this.state.setActive(false);
        this.clearPolling();
        this.clearDebounce();
        this.stopConnectionTestScheduler();
        Logger.info('ProxyMonitor stopped');
    }

    /**
     * Triggers a proxy check with debouncing
     * Multiple triggers within debounce period result in single check
     *
     * @param source - The trigger source ('polling', 'focus', 'config', 'network')
     */
    triggerCheck(source: ProxyCheckTrigger): void {
        if (!this.state.getStatus().isActive) {
            return;
        }

        // Clear existing debounce timer
        this.clearDebounce();

        // Set new debounce timer
        this.debounceTimer = setTimeout(async () => {
            await this.executeCheck(source);
        }, this.config.debounceDelay);
    }

    /**
     * Updates configuration
     * Restarts polling if interval changes
     * Updates connection test scheduler if test interval or enabled state changes
     * Feature: auto-mode-proxy-testing (Task 7.2)
     *
     * @param config - Partial configuration to update
     */
    updateConfig(config: Partial<ProxyMonitorConfig>): void {
        const oldInterval = this.config.pollingInterval;
        const oldTestInterval = this.config.connectionTestInterval;
        const oldTestEnabled = this.config.enableConnectionTest;
        const wasUsingScheduler = this.shouldUseTestScheduler();
        this.config = { ...this.config, ...config };
        this.validateConfig();
        const shouldUseSchedulerNow = this.shouldUseTestScheduler();

        // Restart polling if interval changed and monitoring is active
        if (oldInterval !== this.config.pollingInterval && this.state.getStatus().isActive) {
            this.clearPolling();
            this.setupPolling();
            Logger.info(`Polling interval updated to ${this.config.pollingInterval}ms`);
        }

        // Update test scheduler if connection test interval changed
        if (oldTestInterval !== this.config.connectionTestInterval && this.testScheduler) {
            this.testScheduler.updateInterval(this.config.connectionTestInterval);
            Logger.info(`Connection test interval updated to ${this.config.connectionTestInterval}ms`);
        }

        // Handle enableConnectionTest change
        if (oldTestEnabled !== this.config.enableConnectionTest) {
            if (this.config.enableConnectionTest) {
                // Re-enable connection testing - start scheduler if needed and we have a proxy
                if (shouldUseSchedulerNow && this.lastProxyUrl && this.testScheduler && !this.testScheduler.isActive()) {
                    this.startConnectionTestScheduler(this.lastProxyUrl);
                    Logger.info('Connection testing re-enabled');
                }
            } else {
                // Disable connection testing - stop scheduler
                this.stopConnectionTestScheduler();
                Logger.info('Connection testing disabled');
            }
        }

        // Scheduler necessity can change with polling interval or test interval changes.
        if (wasUsingScheduler !== shouldUseSchedulerNow) {
            if (!shouldUseSchedulerNow) {
                // Stop scheduler to avoid duplicate work; polling-driven checks will handle tests.
                this.stopConnectionTestScheduler();
            } else if (this.config.enableConnectionTest && this.lastProxyUrl && this.testScheduler && !this.testScheduler.isActive()) {
                this.startConnectionTestScheduler(this.lastProxyUrl);
            }
        } else if (shouldUseSchedulerNow && this.config.enableConnectionTest && this.lastProxyUrl && this.testScheduler && this.testScheduler.isActive()) {
            // Keep scheduler aligned with current proxy URL.
            this.testScheduler.updateProxyUrl(this.lastProxyUrl);
        }
    }

    /**
     * Gets current monitoring state
     *
     * @returns Current MonitoringStatus
     */
    getState(): MonitoringStatus {
        return this.state.getStatus();
    }

    /**
     * Executes a proxy check with retry logic and connection testing
     *
     * @param trigger - The trigger source
     */
    private async executeCheck(trigger: ProxyCheckTrigger): Promise<ProxyDetectionResult> {
        if (this.isCheckInProgress) {
            return {
                proxyUrl: this.lastProxyUrl,
                source: null,
                timestamp: Date.now(),
                success: false,
                error: 'Check already in progress'
            };
        }

        this.isCheckInProgress = true;
        this.state.recordCheckStart();

        try {
            const result = await this.detectWithRetry(trigger);
            const useScheduler = this.shouldUseTestScheduler();
            const proxyChanged = result.success && result.proxyUrl !== this.lastProxyUrl;

            // If proxy detected and connection testing is enabled, test the connection
            if (!useScheduler) {
                // Avoid duplicate tests when polling can drive them.
                this.stopConnectionTestScheduler();
            }

            if (result.success && result.proxyUrl && this.connectionTester && this.config.enableConnectionTest) {
                // If scheduler is needed, ensure it's running and aligned with current proxy.
                if (useScheduler && this.testScheduler) {
                    if (this.testScheduler.isActive()) {
                        this.testScheduler.updateProxyUrl(result.proxyUrl);
                    } else if (this.state.getStatus().isActive) {
                        this.startConnectionTestScheduler(result.proxyUrl);
                    }
                }

                const now = Date.now();
                const isPollingTrigger = trigger === 'polling';
                const isTestDueForPolling = this.lastConnectionTestAt === null ||
                    (now - this.lastConnectionTestAt) >= this.config.connectionTestInterval;

                // In scheduler mode, periodic tests are handled by the scheduler; only test immediately on proxy change.
                // Otherwise, test on non-polling triggers and on polling triggers when the test interval has elapsed.
                const shouldRunTest =
                    proxyChanged ||
                    (!useScheduler && (!isPollingTrigger || isTestDueForPolling));

                const testerBusy = typeof this.connectionTester.isTestInProgress === 'function'
                    ? this.connectionTester.isTestInProgress()
                    : false;

                if (shouldRunTest && (!testerBusy || proxyChanged)) {
                    const testResult = await this.connectionTester.testProxyAuto(result.proxyUrl);
                    this.lastConnectionTestAt = testResult.timestamp ?? Date.now();
                    result.testResult = testResult;
                    result.proxyReachable = testResult.success;

                    // Emit test complete event
                    this.emit('proxyTestComplete', testResult);

                    // If test failed, the effective proxy URL should be null (handled by consumer)
                    if (!testResult.success) {
                        Logger.warn(`Proxy ${result.proxyUrl} detected but not reachable`);
                    }

                    // Handle proxy state change based on reachability
                    const wasReachable = this.lastProxyReachable;
                    this.lastProxyReachable = testResult.success;

                    if (wasReachable !== testResult.success) {
                        this.emit('proxyStateChanged', {
                            proxyUrl: result.proxyUrl,
                            reachable: testResult.success,
                            previousState: wasReachable
                        });
                    }
                }
            } else if (result.success && !result.proxyUrl) {
                // No proxy detected: stop scheduler (if running) and reset reachability.
                this.stopConnectionTestScheduler();
                this.lastProxyReachable = false;
            }

            // Log check result
            const checkEvent: ProxyCheckEvent = {
                timestamp: result.timestamp,
                success: result.success,
                proxyUrl: result.proxyUrl,
                source: result.source,
                error: result.error,
                trigger
            };
            this.logger.logCheck(checkEvent);

            // If proxy changed, emit event and log change
            if (result.success && result.proxyUrl !== this.lastProxyUrl) {
                const changeEvent: ProxyChangeEvent = {
                    timestamp: result.timestamp,
                    previousProxy: this.lastProxyUrl,
                    newProxy: result.proxyUrl,
                    source: result.source || 'unknown',
                    trigger
                };
                this.logger.logChange(changeEvent);
                this.emit('proxyChanged', result);
            }

            // Update state
            if (result.success) {
                this.state.recordCheckSuccess(result.proxyUrl, result.source);
                this.lastProxyUrl = result.proxyUrl;
                this.retryCount = 0;
            } else {
                this.state.recordCheckFailure();
            }

            this.emit('checkComplete', result);
            return result;

        } finally {
            this.isCheckInProgress = false;
        }
    }

    /**
     * Detects proxy with retry logic
     *
     * @param trigger - The trigger source
     * @returns Detection result
     */
    private async detectWithRetry(trigger: ProxyCheckTrigger): Promise<ProxyDetectionResult> {
        return detectProxyWithRetry({
            detector: this.detector,
            config: this.config,
            trigger,
            sleep: (ms) => this.sleep(ms),
            onAllRetriesFailed: (data) => this.emit('allRetriesFailed', data)
        });
    }

    /**
     * Helper function to sleep.
     *
     * @param ms - Milliseconds to sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Sets up polling interval
     */
    private setupPolling(): void {
        this.clearPolling();
        this.pollingInterval = setInterval(() => {
            this.triggerCheck('polling');
        }, this.config.pollingInterval);
    }

    /**
     * Clears polling interval
     */
    private clearPolling(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = undefined;
        }
    }

    /**
     * Clears debounce timer
     */
    private clearDebounce(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
    }

    /**
     * Validates and constrains configuration values
     */
    private validateConfig(): void {
        this.config = normalizeProxyMonitorConfig(this.config);
    }

    /**
     * Starts the connection test scheduler
     *
     * @param proxyUrl - The proxy URL to test periodically
     */
    private startConnectionTestScheduler(proxyUrl: string): void {
        if (!this.testScheduler) {
            return;
        }

        this.testScheduler.start(proxyUrl, (testResult: TestResult) => {
            // Handle periodic test result
            this.emit('proxyTestComplete', testResult);
            this.lastConnectionTestAt = testResult.timestamp ?? Date.now();

            const wasReachable = this.lastProxyReachable;
            this.lastProxyReachable = testResult.success;

            const effectiveProxyUrl = testResult.proxyUrl ?? proxyUrl;

            // Emit state change event if reachability changed
            if (wasReachable !== testResult.success) {
                this.emit('proxyStateChanged', {
                    proxyUrl: effectiveProxyUrl,
                    reachable: testResult.success,
                    previousState: wasReachable
                });
            }
        });

        Logger.info(`Connection test scheduler started for ${proxyUrl}`);
    }

    /**
     * Stops the connection test scheduler
     */
    private stopConnectionTestScheduler(): void {
        if (this.testScheduler?.isActive()) {
            this.testScheduler.stop();
            Logger.info('Connection test scheduler stopped');
        }
    }

    /**
     * Gets the last proxy reachability state
     *
     * @returns true if the last tested proxy was reachable
     */
    isProxyReachable(): boolean {
        return this.lastProxyReachable;
    }

    /**
     * Triggers an immediate connection test
     * Useful when user wants to manually verify proxy connectivity
     */
    async triggerConnectionTest(): Promise<TestResult | undefined> {
        if (!this.connectionTester || !this.lastProxyUrl) {
            return undefined;
        }

        return this.connectionTester.testProxyManual(this.lastProxyUrl);
    }
}
