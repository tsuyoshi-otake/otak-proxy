import { EventEmitter } from 'events';
import { ProxyMonitorState, MonitoringStatus } from './ProxyMonitorState';
import { ProxyChangeLogger, ProxyCheckEvent, ProxyChangeEvent } from './ProxyChangeLogger';
import { Logger } from '../utils/Logger';
import { ProxyConnectionTester } from './ProxyConnectionTester';
import { TestResult } from '../utils/ProxyUtils';
import { ReportedProxyChange } from '../utils/ProxyTestTypes';
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
import { detectionSplitRoutingIdentity } from '../config/DetectedProxyValue';

/**
 * Which unsupported auto-config (PAC, WPAD) a detection names, or 'none'.
 * Such a detection has no proxy URL and no split routing, exactly like "no
 * proxy", so neither of those tells the two apart (#130).
 */
function detectedAutoConfig(result: Pick<ProxyDetectionResult, 'kind' | 'capability'>): string {
    return result.capability === 'unsupported' && (result.kind === 'pac' || result.kind === 'wpad')
        ? result.kind
        : 'none';
}

export type { ProxyDetectionResult, ProxyMonitorConfig } from './ProxyMonitorTypes';

/** What the monitor has recorded of its last successful detection, to compare the next one with. */
interface RecordedDetection {
    proxyUrl: string | null;
    splitRouting: string;
    autoConfig: string | undefined;
}

/**
 * How many times in a row a change the listener did not adopt is reported
 * again. Each repeat waits for the next check, so this bounds the extra work
 * of a state that keeps moving under every check (#136).
 */
const MAX_REREPORTS = 3;

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
    // Per-scheme endpoints / bypass of the last successful detection. A change
    // there with the same primary URL still changes routing, so it is a change (#93).
    private lastSplitRouting = detectionSplitRoutingIdentity({});
    // PAC / WPAD of the last successful detection. Undefined until the first
    // one: the start path has already handled what that detection reports.
    private lastAutoConfig: string | undefined;
    private isCheckInProgress: boolean = false;
    /** Invalidates callbacks that started under an earlier start/stop lifecycle. */
    private lifecycleEpoch: number = 0;
    private inFlightEpoch: number | null = null;
    /** Ends the backoff sleeps still pending, so stop() leaves no timer behind. */
    private readonly pendingSleeps = new Set<() => void>();
    /** The change the last check reported, and what was recorded before it (#136). */
    private lastReport?: { result: ProxyDetectionResult; epoch: number; before: RecordedDetection };
    private rereports = 0;
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

    setGenerationCapture(capture: () => Promise<import('../core/LogicalGeneration').LogicalGeneration | undefined>): void {
        this.connectionState.captureGeneration = capture;
        this.connectionState.scheduler?.setGenerationCapture(capture);
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
        this.rereports = 0;
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
        // A stopped lifecycle has no outstanding report: a late answer for it
        // is ignored by the epoch guard anyway, and holding it would only
        // block the quiet-check streak reset in the next lifecycle (#136).
        this.lastReport = undefined;
        this.clearPolling();
        this.clearDebounce();
        this.endPendingSleeps();
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
            let startedGeneration: ProxyDetectionResult['startedGeneration'];
            try {
                startedGeneration = this.connectionState.captureGeneration
                    ? await this.connectionState.captureGeneration()
                    : undefined;
            } catch (error) {
                // Without the fence the check cannot run safely; it ends as a failed
                // detection, publishes nothing, and releases the in-progress flag below.
                const message = error instanceof Error ? error.message : String(error);
                Logger.warn(`Proxy check aborted: capturing the state generation failed: ${message}`);
                // A capture that rejects after stop() or a newer start() belongs to
                // an ended lifecycle: it must not count against the current one.
                if (this.isCurrentLifecycle(epoch)) {
                    this.state.recordCheckFailure();
                }
                return {
                    proxyUrl: this.lastProxyUrl,
                    source: null,
                    timestamp: Date.now(),
                    success: false,
                    error: `Generation capture failed: ${message}`
                };
            }

            const result = {
                ...(await this.detectWithRetry(trigger, epoch)),
                startedGeneration
            };
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
                this.state.getStatus().isActive,
                this.reportedProxyChange(result)
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

    private reportsProxyChange(result: ProxyDetectionResult): boolean {
        return result.success && (
            result.proxyUrl !== this.lastProxyUrl ||
            detectionSplitRoutingIdentity(result) !== this.lastSplitRouting ||
            (this.lastAutoConfig !== undefined && detectedAutoConfig(result) !== this.lastAutoConfig)
        );
    }

    /**
     * The proxyChanged event this check will report, for the connection test
     * and reachability events it emits first: their handlers leave a routing
     * change to that event instead of making it stale (#102). Undefined when
     * the check reports no change or runs without a generation fence.
     */
    private reportedProxyChange(result: ProxyDetectionResult): ReportedProxyChange | undefined {
        if (!result.startedGeneration || !this.reportsProxyChange(result)) {
            return undefined;
        }
        return { startedGeneration: result.startedGeneration, routing: detectionSplitRoutingIdentity(result) };
    }

    private emitProxyChangeIfNeeded(result: ProxyDetectionResult, trigger: ProxyCheckTrigger): void {
        if (!this.reportsProxyChange(result)) {
            // A quiet check ends the not-adopted streak only once no report
            // is still waiting for its answer: the listener resolves the
            // last report asynchronously, and resetting while it can still
            // reject would restart the count at zero on every poll and keep
            // MAX_REREPORTS forever out of reach (#136).
            if (result.success && !this.lastReport) {
                this.rereports = 0;
            }
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
        this.lastReport = { result, epoch: this.lifecycleEpoch, before: this.recordedDetection() };
        this.emit('proxyChanged', result);
    }

    /**
     * The listener's answer to a proxyChanged event it did not take into the
     * state: a generation fence dropped it, and the state still differs from
     * what was detected. The next check reports the detection again, as if this
     * report had not been made. Without it the detection counts as reported and
     * the state keeps the old proxy until the OS proxy changes again (#136).
     *
     * The listener answers after the check that emitted the event has
     * completed. An answer for anything but the latest report of the current
     * lifecycle is ignored: a newer report already replaced it, and after
     * stop() the start path detects afresh. After MAX_REREPORTS answers in a
     * row the detection stays reported, so a state that moves under every check
     * cannot keep a report going.
     */
    proxyChangeNotAdopted(result: ProxyDetectionResult): void {
        const report = this.lastReport;
        if (!report || report.result !== result || !this.isCurrentLifecycle(report.epoch)) {
            return;
        }
        this.lastReport = undefined;

        if (this.rereports >= MAX_REREPORTS) {
            Logger.warn(`Proxy change was not adopted ${MAX_REREPORTS} times in a row; not reporting it again`);
            return;
        }
        this.rereports++;
        this.lastProxyUrl = report.before.proxyUrl;
        this.lastSplitRouting = report.before.splitRouting;
        this.lastAutoConfig = report.before.autoConfig;
        Logger.info('Proxy change was not adopted; the next check reports it again');
    }

    /**
     * The listener's answer to a proxyChanged event it took — or had nothing
     * to take: the report settled. The outstanding-report marker clears and
     * the rejection streak ends: only consecutive not-adopted answers count
     * toward MAX_REREPORTS, and a settled report is what releases a quiet
     * check to reset the count (#136). Answers for anything but the latest
     * report of the current lifecycle are ignored, same as
     * proxyChangeNotAdopted.
     */
    proxyChangeSettled(result: ProxyDetectionResult): void {
        const report = this.lastReport;
        if (!report || report.result !== result || !this.isCurrentLifecycle(report.epoch)) {
            return;
        }
        this.lastReport = undefined;
        this.rereports = 0;
    }

    private recordedDetection(): RecordedDetection {
        return {
            proxyUrl: this.lastProxyUrl,
            splitRouting: this.lastSplitRouting,
            autoConfig: this.lastAutoConfig
        };
    }

    private updateCheckState(result: ProxyDetectionResult): void {
        if (!result.success) {
            this.state.recordCheckFailure();
            return;
        }

        this.state.recordCheckSuccess(result.proxyUrl, result.source);
        this.lastProxyUrl = result.proxyUrl;
        this.lastSplitRouting = detectionSplitRoutingIdentity(result);
        this.lastAutoConfig = detectedAutoConfig(result);
    }

    /**
     * Detects proxy with retry logic
     *
     * @param trigger - The trigger source
     * @param epoch - The lifecycle the check belongs to; once it ended, no attempt
     *   runs. A direct call (a focused unit-level caller) belongs to the current one.
     * @returns Detection result
     */
    private async detectWithRetry(
        trigger: ProxyCheckTrigger,
        epoch: number = this.lifecycleEpoch
    ): Promise<ProxyDetectionResult> {
        return detectProxyWithRetry({
            detector: this.detector,
            config: this.config,
            trigger,
            sleep: (ms) => this.sleep(ms),
            isCancelled: () => !this.isCurrentLifecycle(epoch),
            onAllRetriesFailed: (data) => this.emit('allRetriesFailed', data)
        });
    }

    /**
     * Helper function to sleep. stop() ends it early (see endPendingSleeps).
     *
     * @param ms - Milliseconds to sleep
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const wake = (): void => {
                clearTimeout(timer);
                this.pendingSleeps.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, ms);
            this.pendingSleeps.add(wake);
        });
    }

    /** Wakes every pending backoff sleep; its check sees the ended lifecycle and stops (#136). */
    private endPendingSleeps(): void {
        for (const wake of [...this.pendingSleeps]) {
            wake();
        }
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
