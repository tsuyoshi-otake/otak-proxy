import { EventEmitter } from 'events';
import { ProxyMonitorState, MonitoringStatus } from './ProxyMonitorState';
import { ProxyChangeLogger, ProxyCheckEvent, ProxyChangeEvent } from './ProxyChangeLogger';
import { Logger } from '../utils/Logger';
import { ProxyConnectionTester } from './ProxyConnectionTester';
import { ProxyTestScheduler } from './ProxyTestScheduler';
import { TestResult } from '../utils/ProxyUtils';

/**
 * Configuration options for ProxyMonitor
 */
export interface ProxyMonitorConfig {
    pollingInterval: number;        // Polling interval in milliseconds
    debounceDelay: number;          // Debounce delay in milliseconds
    maxRetries: number;             // Maximum retry attempts
    retryBackoffBase: number;       // Base for exponential backoff in seconds
    detectionSourcePriority: string[]; // Priority order for detection sources
    enableConnectionTest: boolean;  // Enable connection testing in Auto mode
    connectionTestInterval: number; // Connection test interval in milliseconds (default 60s)
}

/**
 * Result of a proxy detection operation
 */
export interface ProxyDetectionResult {
    proxyUrl: string | null;
    source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;
    timestamp: number;
    success: boolean;
    error?: string;
    testResult?: TestResult;        // Connection test result (if enabled)
    proxyReachable?: boolean;       // Whether the proxy is actually reachable
}

/**
 * Interface for SystemProxyDetector to allow mocking
 */
interface ISystemProxyDetector {
    detectSystemProxy(): Promise<string | null>;
    detectSystemProxyWithSource?(): Promise<{ proxyUrl: string | null; source: string | null }>;
}

const DEFAULT_CONFIG: ProxyMonitorConfig = {
    pollingInterval: 30000,     // 30 seconds
    debounceDelay: 1000,        // 1 second
    maxRetries: 3,
    retryBackoffBase: 1,        // 1 second base
    detectionSourcePriority: ['environment', 'vscode', 'platform'],
    enableConnectionTest: true, // Enable connection testing by default
    connectionTestInterval: 60000 // 60 seconds
};

const MIN_POLLING_INTERVAL = 10000;  // 10 seconds
const MAX_POLLING_INTERVAL = 300000; // 300 seconds (5 minutes)

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
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.validateConfig();

        // Set up connection testing if enabled and tester provided
        if (connectionTester && this.config.enableConnectionTest) {
            this.connectionTester = connectionTester;
            this.testScheduler = new ProxyTestScheduler(
                connectionTester,
                this.config.connectionTestInterval
            );
        }
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

        // Start connection test scheduler if we have a proxy URL
        if (this.testScheduler && this.lastProxyUrl) {
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
    triggerCheck(source: 'polling' | 'focus' | 'config' | 'network'): void {
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
        this.config = { ...this.config, ...config };
        this.validateConfig();

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
                // Re-enable connection testing - start scheduler if we have a proxy
                if (this.lastProxyUrl && this.testScheduler && !this.testScheduler.isActive()) {
                    this.startConnectionTestScheduler(this.lastProxyUrl);
                    Logger.info('Connection testing re-enabled');
                }
            } else {
                // Disable connection testing - stop scheduler
                this.stopConnectionTestScheduler();
                Logger.info('Connection testing disabled');
            }
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
    private async executeCheck(trigger: 'polling' | 'focus' | 'config' | 'network'): Promise<ProxyDetectionResult> {
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

            // If proxy detected and connection testing is enabled, test the connection
            if (result.success && result.proxyUrl && this.connectionTester) {
                const testResult = await this.connectionTester.testProxyAuto(result.proxyUrl);
                result.testResult = testResult;
                result.proxyReachable = testResult.success;

                // Emit test complete event
                this.emit('proxyTestComplete', testResult);

                // If test failed, the effective proxy URL should be null
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

                // Update or start the test scheduler
                if (testResult.success && this.testScheduler) {
                    if (this.testScheduler.isActive()) {
                        this.testScheduler.updateProxyUrl(result.proxyUrl);
                    } else {
                        this.startConnectionTestScheduler(result.proxyUrl);
                    }
                } else if (!testResult.success && this.testScheduler?.isActive()) {
                    // Stop scheduler if proxy is not reachable
                    this.stopConnectionTestScheduler();
                }
            } else if (!result.proxyUrl && this.testScheduler?.isActive()) {
                // No proxy detected, stop scheduler
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
    private async detectWithRetry(trigger: 'polling' | 'focus' | 'config' | 'network'): Promise<ProxyDetectionResult> {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                // Wait for backoff if retrying
                if (attempt > 0) {
                    const backoffMs = this.config.retryBackoffBase * Math.pow(2, attempt - 1) * 1000;
                    await this.sleep(backoffMs);
                    Logger.info(`Retry attempt ${attempt} after ${backoffMs}ms backoff`);
                }

                const detection = await this.detectProxy();

                return {
                    proxyUrl: detection.proxyUrl,
                    source: detection.source as ProxyDetectionResult['source'],
                    timestamp: Date.now(),
                    success: true
                };

            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                Logger.warn(`Proxy detection attempt ${attempt + 1} failed: ${lastError}`);

                if (attempt === this.config.maxRetries) {
                    // All retries exhausted
                    this.emit('allRetriesFailed', { error: lastError, trigger });
                }
            }
        }

        return {
            proxyUrl: null,
            source: null,
            timestamp: Date.now(),
            success: false,
            error: lastError
        };
    }

    /**
     * Detects proxy using the detector
     *
     * @returns Detection result with source
     */
    private async detectProxy(): Promise<{ proxyUrl: string | null; source: string | null }> {
        if (this.detector.detectSystemProxyWithSource) {
            return await this.detector.detectSystemProxyWithSource();
        }

        // Fallback if detectSystemProxyWithSource is not available
        const proxyUrl = await this.detector.detectSystemProxy();
        return { proxyUrl, source: null };
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
        // Clamp polling interval to valid range
        if (this.config.pollingInterval < MIN_POLLING_INTERVAL) {
            Logger.warn(`Polling interval ${this.config.pollingInterval}ms is below minimum, using ${MIN_POLLING_INTERVAL}ms`);
            this.config.pollingInterval = MIN_POLLING_INTERVAL;
        }
        if (this.config.pollingInterval > MAX_POLLING_INTERVAL) {
            Logger.warn(`Polling interval ${this.config.pollingInterval}ms is above maximum, using ${MAX_POLLING_INTERVAL}ms`);
            this.config.pollingInterval = MAX_POLLING_INTERVAL;
        }

        // Ensure maxRetries is non-negative
        if (this.config.maxRetries < 0) {
            this.config.maxRetries = 0;
        }

        // Ensure retryBackoffBase is positive
        if (this.config.retryBackoffBase <= 0) {
            this.config.retryBackoffBase = 1;
        }
    }

    /**
     * Helper function to sleep
     *
     * @param ms - Milliseconds to sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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

            const wasReachable = this.lastProxyReachable;
            this.lastProxyReachable = testResult.success;

            // Emit state change event if reachability changed
            if (wasReachable !== testResult.success) {
                this.emit('proxyStateChanged', {
                    proxyUrl: proxyUrl,
                    reachable: testResult.success,
                    previousState: wasReachable
                });

                // If proxy became unreachable, stop the scheduler
                if (!testResult.success) {
                    Logger.warn(`Periodic test failed for ${proxyUrl}, proxy may be down`);
                    this.stopConnectionTestScheduler();
                }
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
