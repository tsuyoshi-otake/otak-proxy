import { isUnsupportedAutoConfig } from '../config/SystemProxyDetector';
import { unsupportedAutoConfigKindLabel } from '../diagnostics/unsupportedAutoConfig';
import { ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { Logger } from '../utils/Logger';
import { isProxyEndpointReachable, isProxyEndpointUnreachable, TestResult } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { commitUnlessStale, publishUnlessStale } from './GenerationFence';
import {
    LogicalGeneration,
    captureLogicalGeneration,
    isStaleGeneration,
    proxyUrlIdentity,
    sameLogicalIdentity
} from './LogicalGeneration';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import { ProxyMode, ProxyState, ProxyTestResult } from './types';
import { setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';

export interface StartupTestState {
    isPending: boolean;
}

export async function handleProxyChanged(
    context: InitializerContext,
    result: ProxyDetectionResult
): Promise<void> {
    const state = await context.proxyStateManager.getState();
    const started = result.startedGeneration ?? captureLogicalGeneration(state);
    if (result.startedGeneration && isStaleGeneration(result.startedGeneration, state)) {
        return;
    }
    if (state.mode !== ProxyMode.Auto) {
        return;
    }

    if (isUnsupportedAutoConfig(result)) {
        await recordUnsupportedAutoConfig(context, started, state, result);
        return;
    }

    // With echo suppression (#29) the monitor reports "no system proxy" while
    // the fallback proxy is engaged — that is the expected steady state, not a
    // removal. Disabling here would tear down the working fallback.
    if (!result.proxyUrl && state.usingFallbackProxy && state.fallbackProxyUrl) {
        return;
    }

    const previousProxy = state.autoProxyUrl;
    const wasAutoModeOff = state.autoModeOff === true;
    applyProxyDetectionResultToState(state, result);

    const recoveredFromAutoOff = wasAutoModeOff && state.autoModeOff === false;
    if (previousProxy === state.autoProxyUrl && !recoveredFromAutoOff && !hasKnownEnableFailure(state)) {
        await commitAndPublish(context, started, 'detection', current => ({
            ...current,
            lastTestResult: state.lastTestResult,
            proxyReachable: state.proxyReachable,
            lastTestTimestamp: state.lastTestTimestamp,
            autoModeOff: state.autoModeOff
        }));
        return;
    }

    await saveApplyThenPublish(context, started, 'detection', state, async () => {
        const shouldEnable = Boolean(state.autoProxyUrl && (result.proxyReachable !== false));
        const applied = await applyProxyThroughContext(context, state.autoProxyUrl || '', shouldEnable);
        context.updateStatusBar?.(await context.proxyStateManager.getState());
        if (applied) {
            notifyProxyChange(context, state, result, previousProxy);
        }
    });
}

async function recordUnsupportedAutoConfig(
    context: InitializerContext,
    started: LogicalGeneration,
    state: ProxyState,
    result: ProxyDetectionResult
): Promise<void> {
    const previousKind = state.lastDetectionKind;
    state.systemProxyDetected = true;
    state.autoModeOff = false;
    state.lastDetectionKind = result.kind;
    state.lastDetectionCapability = result.capability;
    if (result.source) {
        state.lastDetectionSource = result.source;
    }

    await commitAndPublish(context, started, 'detection', current => ({
        ...current,
        systemProxyDetected: true,
        autoModeOff: false,
        lastDetectionKind: result.kind,
        lastDetectionCapability: result.capability,
        lastDetectionSource: result.source ?? current.lastDetectionSource
    }));
    context.updateStatusBar?.(await context.proxyStateManager.getState());

    if (previousKind !== 'pac' && previousKind !== 'wpad') {
        context.userNotifier.showWarning(
            'warning.unsupportedAutoConfig',
            { kind: unsupportedAutoConfigKindLabel(result.kind) }
        );
    }
}

function hasKnownEnableFailure(state: ProxyState): boolean {
    return [
        state.gitConfigured,
        state.vscodeConfigured,
        state.npmConfigured,
        state.pipConfigured,
        state.terminalEnvConfigured
    ].some(value => value === false);
}

export async function handleProxyTestComplete(
    context: InitializerContext,
    startupTestState: StartupTestState,
    testResult: TestResult
): Promise<void> {
    const current = await context.proxyStateManager.getState();
    const started = resolveTestGeneration(testResult, current);

    if (isStaleTestCompletion(started, testResult, current)) {
        clearStartupPendingIfNeeded(startupTestState, testResult);
        return;
    }

    if (current.mode !== ProxyMode.Auto) {
        return;
    }

    const outcome = await commitUnlessStale(context.proxyStateManager, started, 'connectionTest', state => {
        if (state.mode !== ProxyMode.Auto) {
            return undefined;
        }

        const next = { ...state };
        next.lastTestResult = stripGeneration(testResult);
        next.proxyReachable = isProxyEndpointReachable(testResult);
        next.lastTestTimestamp = Date.now();
        updateAutoModeFromTestResult(next, testResult);
        next.convergencePending = isProxyEndpointUnreachable(testResult);
        return next;
    });

    if (outcome === 'stale') {
        clearStartupPendingIfNeeded(startupTestState, testResult);
        return;
    }

    const committed = await context.proxyStateManager.getState();
    await publishUnlessStale(context.publishProxyState, captureLogicalGeneration(committed), 'connectionTest', {
        ...committed,
        convergencePending: false
    });
    context.updateStatusBar?.(committed);
    clearStartupPendingIfNeeded(startupTestState, testResult);

    if (isProxyEndpointUnreachable(testResult)) {
        const latest = await context.proxyStateManager.getState();
        if (latest.mode !== ProxyMode.Auto) {
            return;
        }
        if (testResult.startedGeneration && isStaleGeneration(testResult.startedGeneration, latest)) {
            return;
        }
        if (testResult.proxyUrl && proxyUrlIdentity(testResult.proxyUrl) !== proxyUrlIdentity(latest.autoProxyUrl)) {
            return;
        }
        await applyProxyThroughContext(context, '', false, { silent: true });
    }
}

export async function handleProxyStateChanged(
    context: InitializerContext,
    data: { proxyUrl: string; reachable: boolean; previousState: boolean }
): Promise<void> {
    const started = captureLogicalGeneration(await context.proxyStateManager.getState());
    const state = await context.proxyStateManager.getState();

    if (state.mode !== ProxyMode.Auto) {
        return;
    }

    if (proxyUrlIdentity(data.proxyUrl) !== proxyUrlIdentity(state.autoProxyUrl) && data.proxyUrl) {
        // Reachability event for a different endpoint must not mutate the current generation.
        return;
    }

    state.proxyReachable = data.reachable;
    await applyReachabilityChange(context, started, state, data);
}

async function commitAndPublish(
    context: InitializerContext,
    started: LogicalGeneration,
    owner: 'detection' | 'connectionTest' | 'autoMonitoring' | 'stateChanged',
    fold: (current: ProxyState) => ProxyState | undefined
): Promise<void> {
    const outcome = await commitUnlessStale(context.proxyStateManager, started, owner, fold);
    if (outcome === 'stale') {
        return;
    }

    const current = await context.proxyStateManager.getState();
    await publishUnlessStale(
        context.publishProxyState,
        captureLogicalGeneration(current),
        owner,
        current
    );
}

async function saveApplyThenPublish(
    context: InitializerContext,
    started: LogicalGeneration,
    owner: 'detection' | 'autoMonitoring' | 'stateChanged',
    desired: ProxyState,
    apply: () => Promise<void>
): Promise<void> {
    const pending = await commitUnlessStale(context.proxyStateManager, started, owner, current => ({
        ...current,
        ...desired,
        revision: current.revision,
        convergencePending: true
    }));
    if (pending === 'stale') {
        return;
    }

    await apply();

    const afterApply = await context.proxyStateManager.getState();
    const desiredIdentity = captureLogicalGeneration({ ...desired, revision: afterApply.revision });
    if (!sameLogicalIdentity(desiredIdentity, captureLogicalGeneration(afterApply))) {
        return;
    }

    const cleared = await commitUnlessStale(
        context.proxyStateManager,
        captureLogicalGeneration(afterApply),
        owner,
        current => ({ ...current, convergencePending: false })
    );
    if (cleared === 'stale') {
        return;
    }

    const published = await context.proxyStateManager.getState();
    await publishUnlessStale(
        context.publishProxyState,
        captureLogicalGeneration(published),
        owner,
        published
    );
}

function applyProxyDetectionResultToState(state: ProxyState, result: ProxyDetectionResult): void {
    state.autoProxyUrl = result.proxyUrl || undefined;

    if (result.proxyUrl) {
        state.lastDetectionKind = result.kind ?? 'singleProxy';
        state.lastDetectionCapability = result.capability ?? 'supported';
        if (result.proxyUrl !== state.fallbackProxyUrl) {
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            state.lastDetectionSource = result.source ?? undefined;
        }
        // Detected URL equals the engaged fallback URL: keep the fallback
        // flags and its 'fallback' provenance untouched.
    } else {
        state.lastDetectionSource = undefined;
        state.lastDetectionKind = 'direct';
        state.lastDetectionCapability = 'supported';
    }

    if (result.testResult) {
        state.lastTestResult = stripGeneration(result.testResult);
        state.proxyReachable = result.proxyReachable;
        state.lastTestTimestamp = Date.now();
        updateAutoModeFromTestResult(state, result.testResult);
    }

    setRequiresAuthFromLiveUrls(state);
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
    if (isProxyEndpointUnreachable(testResult)) {
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        Logger.info('Proxy endpoint unreachable - Auto Mode OFF');
        return;
    }

    if (testResult.success) {
        state.autoModeOff = false;
    }
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
    started: LogicalGeneration,
    state: ProxyState,
    data: { proxyUrl: string; reachable: boolean; previousState: boolean }
): Promise<void> {
    if (data.reachable && !data.previousState) {
        state.autoModeOff = false;
        await saveApplyThenPublish(context, started, 'autoMonitoring', state, async () => {
            await applyProxyThroughContext(context, data.proxyUrl, true, { silent: true });
            Logger.info(`Proxy ${data.proxyUrl} became reachable, enabling proxy`);
        });
        context.updateStatusBar?.(await context.proxyStateManager.getState());
        return;
    }

    if (!data.reachable && data.previousState) {
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        await saveApplyThenPublish(context, started, 'stateChanged', state, async () => {
            await applyProxyThroughContext(context, data.proxyUrl, false, { silent: true });
            Logger.info(`Proxy ${data.proxyUrl} became unreachable, Auto Mode OFF`);
        });
        context.updateStatusBar?.(await context.proxyStateManager.getState());
        return;
    }

    await commitAndPublish(context, started, 'stateChanged', current => ({
        ...current,
        proxyReachable: data.reachable
    }));
    context.updateStatusBar?.(await context.proxyStateManager.getState());
}

function resolveTestGeneration(testResult: TestResult, current: ProxyState): LogicalGeneration {
    if (testResult.startedGeneration) {
        return testResult.startedGeneration;
    }

    return captureLogicalGeneration({
        ...current,
        autoProxyUrl: testResult.proxyUrl ?? current.autoProxyUrl
    });
}

function isStaleTestCompletion(
    started: LogicalGeneration,
    testResult: TestResult,
    current: ProxyState
): boolean {
    if (testResult.startedGeneration) {
        return isStaleGeneration(started, current);
    }

    if (current.mode !== ProxyMode.Auto) {
        return true;
    }

    if (testResult.proxyUrl && proxyUrlIdentity(testResult.proxyUrl) !== proxyUrlIdentity(current.autoProxyUrl)) {
        return true;
    }

    return false;
}

function stripGeneration(testResult: TestResult): ProxyTestResult {
    const { startedGeneration: _started, ...rest } = testResult;
    return rest as ProxyTestResult;
}
