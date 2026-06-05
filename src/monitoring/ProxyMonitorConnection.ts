import { Logger } from '../utils/Logger';
import { TestResult } from '../utils/ProxyUtils';
import { ProxyConnectionTester } from './ProxyConnectionTester';
import { ProxyTestScheduler } from './ProxyTestScheduler';
import { ProxyCheckTrigger, ProxyDetectionResult, ProxyMonitorConfig } from './ProxyMonitorTypes';

export interface ProxyMonitorConnectionEvents {
    onTestComplete(result: TestResult): void;
    onReachabilityChanged(data: { proxyUrl: string; reachable: boolean; previousState: boolean }): void;
}

export interface ProxyMonitorConnectionState {
    tester?: ProxyConnectionTester;
    scheduler?: ProxyTestScheduler;
    lastProxyReachable: boolean;
    lastConnectionTestAt: number | null;
    events: ProxyMonitorConnectionEvents;
}

export function createProxyMonitorConnectionState(
    tester: ProxyConnectionTester | undefined,
    events: ProxyMonitorConnectionEvents,
    initialConfig: ProxyMonitorConfig
): ProxyMonitorConnectionState {
    return {
        tester,
        scheduler: tester ? new ProxyTestScheduler(tester, initialConfig.connectionTestInterval) : undefined,
        lastProxyReachable: false,
        lastConnectionTestAt: null,
        events
    };
}

function shouldUseConnectionScheduler(
    state: ProxyMonitorConnectionState,
    config: ProxyMonitorConfig
): boolean {
    return Boolean(
        state.tester &&
        state.scheduler &&
        config.enableConnectionTest &&
        config.pollingInterval > config.connectionTestInterval
    );
}

export function handleConnectionConfigChange(
    state: ProxyMonitorConnectionState,
    oldConfig: ProxyMonitorConfig,
    newConfig: ProxyMonitorConfig,
    lastProxyUrl: string | null
): void {
    const wasUsingScheduler = shouldUseConnectionScheduler(state, oldConfig);
    const shouldUseSchedulerNow = shouldUseConnectionScheduler(state, newConfig);

    updateConnectionTestInterval(state, oldConfig, newConfig);
    handleConnectionTestEnabledChange(state, oldConfig, newConfig, shouldUseSchedulerNow, lastProxyUrl);
    reconcileSchedulerUsage(state, wasUsingScheduler, shouldUseSchedulerNow, newConfig, lastProxyUrl);
}

export function startConnectionSchedulerIfNeeded(
    state: ProxyMonitorConnectionState,
    config: ProxyMonitorConfig,
    lastProxyUrl: string | null
): void {
    if (shouldUseConnectionScheduler(state, config) && lastProxyUrl && state.scheduler && !state.scheduler.isActive()) {
        startConnectionScheduler(state, lastProxyUrl);
    }
}

export function stopConnectionScheduler(state: ProxyMonitorConnectionState): void {
    if (state.scheduler?.isActive()) {
        state.scheduler.stop();
        Logger.info('Connection test scheduler stopped');
    }
}

export async function handleConnectionDetectionResult(
    state: ProxyMonitorConnectionState,
    result: ProxyDetectionResult,
    trigger: ProxyCheckTrigger,
    config: ProxyMonitorConfig,
    lastProxyUrl: string | null,
    monitorActive: boolean
): Promise<void> {
    const useScheduler = shouldUseConnectionScheduler(state, config);
    const proxyChanged = result.success && result.proxyUrl !== lastProxyUrl;

    if (!useScheduler) {
        stopConnectionScheduler(state);
    }

    if (canTestDetectedProxy(state, result, config)) {
        alignSchedulerForDetectedProxy(state, result.proxyUrl!, useScheduler, monitorActive);
        await runConnectionTestIfNeeded(state, result, trigger, proxyChanged, useScheduler, config);
        return;
    }

    resetConnectionStateWhenNoProxy(state, result);
}

export function isConnectionProxyReachable(state: ProxyMonitorConnectionState): boolean {
    return state.lastProxyReachable;
}

export async function triggerManualConnectionTest(
    state: ProxyMonitorConnectionState,
    lastProxyUrl: string | null
): Promise<TestResult | undefined> {
    if (!state.tester || !lastProxyUrl) {
        return undefined;
    }

    return state.tester.testProxyManual(lastProxyUrl);
}

function updateConnectionTestInterval(
    state: ProxyMonitorConnectionState,
    oldConfig: ProxyMonitorConfig,
    newConfig: ProxyMonitorConfig
): void {
    if (oldConfig.connectionTestInterval === newConfig.connectionTestInterval || !state.scheduler) {
        return;
    }

    state.scheduler.updateInterval(newConfig.connectionTestInterval);
    Logger.info(`Connection test interval updated to ${newConfig.connectionTestInterval}ms`);
}

function handleConnectionTestEnabledChange(
    state: ProxyMonitorConnectionState,
    oldConfig: ProxyMonitorConfig,
    newConfig: ProxyMonitorConfig,
    shouldUseSchedulerNow: boolean,
    lastProxyUrl: string | null
): void {
    if (oldConfig.enableConnectionTest === newConfig.enableConnectionTest) {
        return;
    }

    if (!newConfig.enableConnectionTest) {
        stopConnectionScheduler(state);
        Logger.info('Connection testing disabled');
        return;
    }

    startConnectionSchedulerForMode(state, shouldUseSchedulerNow, lastProxyUrl);
    Logger.info('Connection testing re-enabled');
}

function reconcileSchedulerUsage(
    state: ProxyMonitorConnectionState,
    wasUsingScheduler: boolean,
    shouldUseSchedulerNow: boolean,
    config: ProxyMonitorConfig,
    lastProxyUrl: string | null
): void {
    if (wasUsingScheduler !== shouldUseSchedulerNow) {
        updateSchedulerMode(state, shouldUseSchedulerNow, lastProxyUrl);
        return;
    }

    if (isSchedulerActiveForCurrentProxy(state, shouldUseSchedulerNow, config, lastProxyUrl)) {
        state.scheduler!.updateProxyUrl(lastProxyUrl!);
    }
}

function updateSchedulerMode(
    state: ProxyMonitorConnectionState,
    shouldUseSchedulerNow: boolean,
    lastProxyUrl: string | null
): void {
    if (!shouldUseSchedulerNow) {
        stopConnectionScheduler(state);
        return;
    }

    startConnectionSchedulerForMode(state, shouldUseSchedulerNow, lastProxyUrl);
}

function startConnectionSchedulerForMode(
    state: ProxyMonitorConnectionState,
    shouldUseSchedulerNow: boolean,
    lastProxyUrl: string | null
): void {
    if (shouldUseSchedulerNow && lastProxyUrl && state.scheduler && !state.scheduler.isActive()) {
        startConnectionScheduler(state, lastProxyUrl);
    }
}

function isSchedulerActiveForCurrentProxy(
    state: ProxyMonitorConnectionState,
    shouldUseSchedulerNow: boolean,
    config: ProxyMonitorConfig,
    lastProxyUrl: string | null
): boolean {
    return Boolean(
        shouldUseSchedulerNow &&
        config.enableConnectionTest &&
        lastProxyUrl &&
        state.scheduler?.isActive()
    );
}

function startConnectionScheduler(state: ProxyMonitorConnectionState, proxyUrl: string): void {
    if (!state.scheduler) {
        return;
    }

    state.scheduler.start(proxyUrl, (testResult: TestResult) => {
        recordScheduledTestResult(state, proxyUrl, testResult);
    });

    Logger.info(`Connection test scheduler started for ${proxyUrl}`);
}

function recordScheduledTestResult(
    state: ProxyMonitorConnectionState,
    proxyUrl: string,
    testResult: TestResult
): void {
    state.events.onTestComplete(testResult);
    state.lastConnectionTestAt = testResult.timestamp ?? Date.now();

    const effectiveProxyUrl = testResult.proxyUrl ?? proxyUrl;
    updateReachabilityState(state, effectiveProxyUrl, testResult.success);
}

function canTestDetectedProxy(
    state: ProxyMonitorConnectionState,
    result: ProxyDetectionResult,
    config: ProxyMonitorConfig
): boolean {
    return Boolean(
        result.success &&
        result.proxyUrl &&
        state.tester &&
        config.enableConnectionTest
    );
}

function alignSchedulerForDetectedProxy(
    state: ProxyMonitorConnectionState,
    proxyUrl: string,
    useScheduler: boolean,
    monitorActive: boolean
): void {
    if (!useScheduler || !state.scheduler) {
        return;
    }

    if (state.scheduler.isActive()) {
        state.scheduler.updateProxyUrl(proxyUrl);
    } else if (monitorActive) {
        startConnectionScheduler(state, proxyUrl);
    }
}

async function runConnectionTestIfNeeded(
    state: ProxyMonitorConnectionState,
    result: ProxyDetectionResult,
    trigger: ProxyCheckTrigger,
    proxyChanged: boolean,
    useScheduler: boolean,
    config: ProxyMonitorConfig
): Promise<void> {
    if (!shouldRunConnectionTest(state, trigger, proxyChanged, useScheduler, config)) {
        return;
    }

    if (isConnectionTesterBusy(state) && !proxyChanged) {
        return;
    }

    const testResult = await state.tester!.testProxyAuto(result.proxyUrl!);
    recordConnectionTestResult(state, result, testResult);
}

function shouldRunConnectionTest(
    state: ProxyMonitorConnectionState,
    trigger: ProxyCheckTrigger,
    proxyChanged: boolean,
    useScheduler: boolean,
    config: ProxyMonitorConfig
): boolean {
    const isPollingTrigger = trigger === 'polling';
    const isTestDueForPolling = isConnectionTestDue(state, config);

    return proxyChanged || (!useScheduler && (!isPollingTrigger || isTestDueForPolling));
}

function isConnectionTestDue(state: ProxyMonitorConnectionState, config: ProxyMonitorConfig): boolean {
    return state.lastConnectionTestAt === null ||
        (Date.now() - state.lastConnectionTestAt) >= config.connectionTestInterval;
}

function isConnectionTesterBusy(state: ProxyMonitorConnectionState): boolean {
    return typeof state.tester?.isTestInProgress === 'function'
        ? state.tester.isTestInProgress()
        : false;
}

function recordConnectionTestResult(
    state: ProxyMonitorConnectionState,
    result: ProxyDetectionResult,
    testResult: TestResult
): void {
    state.lastConnectionTestAt = testResult.timestamp ?? Date.now();
    result.testResult = testResult;
    result.proxyReachable = testResult.success;
    state.events.onTestComplete(testResult);

    if (!testResult.success) {
        Logger.warn(`Proxy ${result.proxyUrl} detected but not reachable`);
    }

    updateReachabilityState(state, result.proxyUrl!, testResult.success);
}

function updateReachabilityState(
    state: ProxyMonitorConnectionState,
    proxyUrl: string,
    reachable: boolean
): void {
    const wasReachable = state.lastProxyReachable;
    state.lastProxyReachable = reachable;

    if (wasReachable !== reachable) {
        state.events.onReachabilityChanged({
            proxyUrl,
            reachable,
            previousState: wasReachable
        });
    }
}

function resetConnectionStateWhenNoProxy(
    state: ProxyMonitorConnectionState,
    result: ProxyDetectionResult
): void {
    if (result.success && !result.proxyUrl) {
        stopConnectionScheduler(state);
        state.lastProxyReachable = false;
    }
}
