import { clearDetectedSplitFields, splitRoutingIdentity } from '../config/DetectedProxyValue';
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
import type { ManualFallbackOutcome } from './SystemProxyUpdateService';
import { ProxyMode, ProxyState, ProxyTestResult } from './types';
import { setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';

export interface StartupTestState {
    isPending: boolean;
}

export async function handleProxyChanged(
    context: InitializerContext,
    result: ProxyDetectionResult,
    resolveManualFallback?: (state: ProxyState) => Promise<ManualFallbackOutcome>
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
    const previousSplitRouting = splitRoutingIdentity(state);
    const wasAutoModeOff = state.autoModeOff === true;
    applyProxyDetectionResultToState(state, result);

    // A system proxy lost mid-session resolves like one missing at startup:
    // the manual fallback, or Auto OFF when it does not answer (#85). The
    // fallback test awaits; the generation fence below drops the result if a
    // toggle or sync committed meanwhile.
    const fallback = !result.proxyUrl && resolveManualFallback
        ? await resolveFallbackOrClear(resolveManualFallback, state)
        : undefined;
    const fallbackEngaged = fallback === 'engaged';

    const recoveredFromAutoOff = wasAutoModeOff && state.autoModeOff === false;
    const samePrimaryProxy = previousProxy === state.autoProxyUrl;
    // Auto: OFF removed the proxy because this URL did not answer. The same URL
    // without a new connection test says nothing new about that, so whatever
    // else changed (per-scheme URLs, bypass) is only saved for the reachability
    // recovery to apply (#93). The Configured flags are false here because of
    // that removal, not because an enable failed.
    const stillOffWithoutNewTest =
        Boolean(result.proxyUrl) && samePrimaryProxy && state.autoModeOff === true && !result.testResult;
    // An engaged fallback always goes through apply, even when its URL equals
    // the lost system proxy: the fallback flags are only saved on that path.
    // A per-scheme or bypass change with the same primary URL is a change too:
    // the split fields are applied on that path (#93).
    const unchanged =
        samePrimaryProxy &&
        previousSplitRouting === splitRoutingIdentity(state) &&
        !recoveredFromAutoOff &&
        !fallbackEngaged &&
        !hasKnownEnableFailure(state);
    if (stillOffWithoutNewTest || unchanged) {
        await commitAndPublish(context, started, 'detection', current => ({
            ...current,
            lastTestResult: state.lastTestResult,
            proxyReachable: state.proxyReachable,
            lastTestTimestamp: state.lastTestTimestamp,
            autoModeOff: state.autoModeOff,
            lastDetectionKind: state.lastDetectionKind,
            lastDetectionCapability: state.lastDetectionCapability,
            autoProxyKind: state.autoProxyKind,
            autoHttpProxyUrl: state.autoHttpProxyUrl,
            autoHttpsProxyUrl: state.autoHttpsProxyUrl,
            detectedBypass: state.detectedBypass
        }));
        return;
    }

    await saveApplyThenPublish(context, started, 'detection', state, async () => {
        // result.proxyReachable describes the lost system proxy; the fallback
        // was just tested reachable.
        const shouldEnable = Boolean(state.autoProxyUrl && (fallbackEngaged || result.proxyReachable !== false));
        const applied = await applyProxyThroughContext(context, state.autoProxyUrl || '', shouldEnable);
        context.updateStatusBar?.(await context.proxyStateManager.getState());
        if (applied) {
            notifyProxyChange(context, state, result, previousProxy, fallbackEngaged);
        }
    });
}

/**
 * A fallback that cannot be resolved must not leave the lost proxy applied.
 * Report 'notConfigured' so the caller clears it, as it did before #85.
 */
async function resolveFallbackOrClear(
    resolveManualFallback: (state: ProxyState) => Promise<ManualFallbackOutcome>,
    state: ProxyState
): Promise<ManualFallbackOutcome> {
    try {
        return await resolveManualFallback(state);
    } catch (error) {
        Logger.warn('Manual fallback resolution failed; clearing the lost system proxy:', error);
        return 'notConfigured';
    }
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
        // Same fields assignDetectedProxyToState writes on the startup path, so
        // a stale per-scheme URL from the previous detection cannot survive (#93).
        state.autoProxyKind = result.kind;
        state.autoHttpProxyUrl = result.httpUrl;
        state.autoHttpsProxyUrl = result.httpsUrl;
        state.detectedBypass = result.bypass;
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
        clearDetectedSplitFields(state);
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
    previousProxy: string | undefined,
    fallbackEngaged: boolean
): void {
    if (fallbackEngaged && state.autoProxyUrl) {
        context.userNotifier.showSuccess(
            'fallback.usingManualProxy',
            { url: context.sanitizer.maskPassword(state.autoProxyUrl) }
        );
        return;
    }

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
