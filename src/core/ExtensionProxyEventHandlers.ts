import { ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { Logger } from '../utils/Logger';
import { TestResult } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { ProxyMode, ProxyState, ProxyTestResult } from './types';

export interface StartupTestState {
    isPending: boolean;
}

export async function handleProxyChanged(
    context: InitializerContext,
    result: ProxyDetectionResult
): Promise<void> {
    const state = await context.proxyStateManager.getState();
    if (state.mode !== ProxyMode.Auto) {
        return;
    }

    const previousProxy = state.autoProxyUrl;
    applyProxyDetectionResultToState(state, result);

    if (previousProxy === state.autoProxyUrl) {
        await context.proxyStateManager.saveState(state);
        return;
    }

    await saveAndApplyProxyChange(context, state, result, previousProxy);
}

export async function handleProxyTestComplete(
    context: InitializerContext,
    startupTestState: StartupTestState,
    testResult: TestResult
): Promise<void> {
    const state = await context.proxyStateManager.getState();

    if (state.mode !== ProxyMode.Auto) {
        return;
    }

    state.lastTestResult = testResult as ProxyTestResult;
    state.proxyReachable = testResult.success;
    state.lastTestTimestamp = Date.now();
    updateAutoModeFromTestResult(state, testResult);

    await context.proxyStateManager.saveState(state);
    context.updateStatusBar?.(state);
    clearStartupPendingIfNeeded(startupTestState, testResult);
}

export async function handleProxyStateChanged(
    context: InitializerContext,
    data: { proxyUrl: string; reachable: boolean; previousState: boolean }
): Promise<void> {
    const state = await context.proxyStateManager.getState();

    if (state.mode !== ProxyMode.Auto) {
        return;
    }

    state.proxyReachable = data.reachable;
    await applyReachabilityChange(context, state, data);

    await context.proxyStateManager.saveState(state);
    context.updateStatusBar?.(state);
}

function applyProxyDetectionResultToState(state: ProxyState, result: ProxyDetectionResult): void {
    state.autoProxyUrl = result.proxyUrl || undefined;

    if (result.testResult) {
        state.lastTestResult = result.testResult as ProxyTestResult;
        state.proxyReachable = result.proxyReachable;
        state.lastTestTimestamp = Date.now();
    }
}

async function saveAndApplyProxyChange(
    context: InitializerContext,
    state: ProxyState,
    result: ProxyDetectionResult,
    previousProxy: string | undefined
): Promise<void> {
    await context.proxyStateManager.saveState(state);

    const shouldEnable = Boolean(state.autoProxyUrl && (result.proxyReachable !== false));
    await context.proxyApplier.applyProxy(state.autoProxyUrl || '', shouldEnable);
    notifyProxyChange(context, state, result, previousProxy);
}

function notifyProxyChange(
    context: InitializerContext,
    state: ProxyState,
    result: ProxyDetectionResult,
    previousProxy: string | undefined
): void {
    if (state.autoProxyUrl && result.proxyReachable !== false) {
        context.userNotifier.showSuccess(
            'message.systemProxyChanged',
            { url: context.sanitizer.maskPassword(state.autoProxyUrl) }
        );
        return;
    }

    if (previousProxy && !state.autoProxyUrl) {
        context.userNotifier.showSuccess('message.systemProxyRemoved');
    }
}

function updateAutoModeFromTestResult(state: ProxyState, testResult: TestResult): void {
    if (!testResult.success) {
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        Logger.info('Proxy test failed - Auto Mode OFF');
        return;
    }

    state.autoModeOff = false;
}

function clearStartupPendingIfNeeded(startupTestState: StartupTestState, testResult: TestResult): void {
    if (!startupTestState.isPending) {
        return;
    }

    startupTestState.isPending = false;
    Logger.info(`Startup connection test completed: ${testResult.success ? 'success' : 'failed'}`);
}

async function applyReachabilityChange(
    context: InitializerContext,
    state: ProxyState,
    data: { proxyUrl: string; reachable: boolean; previousState: boolean }
): Promise<void> {
    if (data.reachable && !data.previousState) {
        state.autoModeOff = false;
        await context.proxyApplier.applyProxy(data.proxyUrl, true, { silent: true });
        Logger.info(`Proxy ${data.proxyUrl} became reachable, enabling proxy`);
        return;
    }

    if (!data.reachable && data.previousState) {
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        await context.proxyApplier.applyProxy(data.proxyUrl, false, { silent: true });
        Logger.info(`Proxy ${data.proxyUrl} became unreachable, Auto Mode OFF`);
    }
}
