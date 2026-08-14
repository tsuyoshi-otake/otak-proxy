import { EventEmitter } from 'events';
import { ProxyMonitorState, MonitoringStatus } from './ProxyMonitorState';
import { ProxyChangeLogger, ProxyCheckEvent, ProxyChangeEvent } from './ProxyChangeLogger';
import { Logger } from '../utils/Logger';
import { ProxyConnectionTester } from './ProxyConnectionTester';
import { TestResult } from '../utils/ProxyUtils';
import {
    createProxyMonitorConnectionState,
    handleConnectionConfigChange,
    handleConnectionDetectionResult,
    isConnectionProxyReachable,
    ProxyMonitorConnectionState,
    startConnectionSchedulerIfNeeded,
    stopConnectionScheduler,
    triggerManualConnectionTest
} from './ProxyMonitorConnection';
import {
    ISystemProxyDetector,
    ProxyCheckTrigger,
    ProxyDetectionResult,
    ProxyMonitorConfig
} from './ProxyMonitorTypes';
import {
    DEFAULT_PROXY_MONITOR_CONFIG,
    deriveEffectiveProxyMonitorConfig,
    normalizeProxyMonitorConfig
} from './ProxyMonitorConfig';
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
    /** Configured intervals, before any focus-based backoff is applied. */
    private baseConfig: ProxyMonitorConfig;
    /** Intervals currently in effect (baseConfig adjusted for window focus). */
    private config: ProxyMonitorConfig;
    private windowFocused: boolean = true;
    private detector: ISystemProxyDetector;
    private logger: ProxyChangeLogger;
    private state: ProxyMonitorState;
    private pollingInterval?: NodeJS.Timeout;
    private debounceTimer?: NodeJS.Timeout;
    private lastProxyUrl: string | null = null;
    private isCheckInProgress: boolean = false;
    /** Invalidates callbacks that started under an earlier start/stop lifecycle. */
    private lifecycleEpoch: number = 0;
    private inFlightEpoch: number | null = null;
    private connectionState: ProxyMonitorConnectionState;

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
        this.baseConfig = normalizeProxyMonitorConfig({ ...DEFAULT_PROXY_MONITOR_CONFIG, ...config });
        this.config = deriveEffectiveProxyMonitorConfig(this.baseConfig, this.windowFocused);
        this.connectionState = createProxyMonitorConnectionState(
            connectionTester,
            {
                onTestComplete: (result) => this.emit('proxyTestComplete', result),
                onReachabilityChanged: (data) => this.emit('proxyStateChanged', data)
            },
            this.config
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

        this.lifecycleEpoch++;
        this.state.setActive(true);
        this.setupPolling();
        Logger.info('ProxyMonitor started');

        startConnectionSchedulerIfNeeded(this.connectionState, this.config, this.lastProxyUrl);
    }

    /**
     * Stops proxy monitoring
     * Clears all timers and stops scheduler
     */
    stop(): void {
        this.lifecycleEpoch++;
        this.state.setActive(false);
        this.isCheckInProgress = false;
        this.inFlightEpoch = null;
        this.clearPolling();
        this.clearDebounce();
        stopConnectionScheduler(this.connectionState);
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
        this.applyConfig({ ...this.baseConfig, ...config });
    }

    /**
     * Records whether the VS Code window hosting this monitor is focused.
     *
     * Unfocused windows back off to longer polling and connection-test
     * intervals; refocusing restores the configured cadence immediately.
     *
     * @param focused - True when the window has focus
     */
    setWindowFocused(focused: boolean): void {
        if (this.windowFocused === focused) {
            return;
        }

        this.windowFocused = focused;
        this.applyConfig(this.baseConfig);
    }

    /**
     * Applies a new base configuration and re-derives the effective intervals,
     * restarting timers only when the effective values actually changed.
     */
    private applyConfig(nextBaseConfig: ProxyMonitorConfig): void {
        const oldConfig = this.config;

        this.baseConfig = normalizeProxyMonitorConfig(nextBaseConfig);
        this.config = deriveEffectiveProxyMonitorConfig(this.baseConfig, this.windowFocused);

        this.updatePollingInterval(oldConfig.pollingInterval);
        handleConnectionConfigChange(this.connectionState, oldConfig, this.config, this.lastProxyUrl);
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
        const epoch = this.lifecycleEpoch;
        if (this.isCheckInProgress && this.inFlightEpoch === epoch) {
            return this.createInProgressResult();
        }

        this.isCheckInProgress = true;
        this.inFlightEpoch = epoch;
        this.state.recordCheckStart();

        try {
            const result = await this.detectWithRetry(trigger);
            // A detector may resolve after stop() or after a newer start(). Its
            // observation is diagnostic only; it must not publish state/events
            // into the newer lifecycle.
            if (!this.isCurrentLifecycle(epoch)) {
                return {
                    ...result,
                    success: false,
                    error: 'Check result discarded after lifecycle stop'
                };
            }
            await handleConnectionDetectionResult(
                this.connectionState,
                result,
                trigger,
                this.config,
                this.lastProxyUrl,
                this.state.getStatus().isActive
            );
            this.logCheckResult(result, trigger);
            this.emitProxyChangeIfNeeded(result, trigger);
            this.updateCheckState(result);
            this.emit('checkComplete', result);
            return result;

        } finally {
            if (this.inFlightEpoch === epoch) {
                this.isCheckInProgress = false;
                this.inFlightEpoch = null;
            }
        }
    }

    private isCurrentLifecycle(epoch: number): boolean {
        // Some focused unit-level callers invoke the check operation directly
        // without first starting polling.  Epoch equality is the lifecycle
        // ownership proof: start() and stop() both advance it, so a late result
        // from an earlier active lifecycle is still discarded without treating
        // an explicitly direct diagnostic check as stopped.
        return this.lifecycleEpoch === epoch;
    }

    private updatePollingInterval(oldInterval: number): void {
        if (oldInterval === this.config.pollingInterval || !this.state.getStatus().isActive) {
            return;
        }

        this.clearPolling();
        this.setupPolling();
        Logger.info(`Polling interval updated to ${this.config.pollingInterval}ms`);
    }

    private createInProgressResult(): ProxyDetectionResult {
        return {
            proxyUrl: this.lastProxyUrl,
            source: null,
            timestamp: Date.now(),
            success: false,
            error: 'Check already in progress'
        };
    }

    private logCheckResult(result: ProxyDetectionResult, trigger: ProxyCheckTrigger): void {
        const checkEvent: ProxyCheckEvent = {
            timestamp: result.timestamp,
            success: result.success,
            proxyUrl: result.proxyUrl,
            source: result.source,
            error: result.error,
            trigger
        };
        this.logger.logCheck(checkEvent);
    }

    private emitProxyChangeIfNeeded(result: ProxyDetectionResult, trigger: ProxyCheckTrigger): void {
        if (!result.success || result.proxyUrl === this.lastProxyUrl) {
            return;
        }

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

    private updateCheckState(result: ProxyDetectionResult): void {
        if (!result.success) {
            this.state.recordCheckFailure();
            return;
        }

        this.state.recordCheckSuccess(result.proxyUrl, result.source);
        this.lastProxyUrl = result.proxyUrl;
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
     * Gets the last proxy reachability state
     *
     * @returns true if the last tested proxy was reachable
     */
    isProxyReachable(): boolean {
        return isConnectionProxyReachable(this.connectionState);
    }

    /**
     * Triggers an immediate connection test
     * Useful when user wants to manually verify proxy connectivity
     */
    async triggerConnectionTest(): Promise<TestResult | undefined> {
        return triggerManualConnectionTest(this.connectionState, this.lastProxyUrl);
    }
}
