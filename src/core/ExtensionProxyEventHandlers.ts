import { clearDetectedSplitFields, splitRoutingIdentity } from '../config/DetectedProxyValue';
import { isUnsupportedAutoConfig } from '../config/SystemProxyDetector';
import { unsupportedAutoConfigKindLabel } from '../diagnostics/unsupportedAutoConfig';
import { ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import type { ReachabilityChange } from '../monitoring/ProxyMonitorConnection';
import { Logger } from '../utils/Logger';
import {
    isProxyEndpointReachable,
    isProxyEndpointUnreachable,
    proxyEndpointVerdict,
    TestResult
} from '../utils/ProxyUtils';
import type { ReportedProxyChange } from '../utils/ProxyTestTypes';
import { InitializerContext } from './ExtensionInitializerTypes';
import { commitUnlessStale, commitUnlessStaleWithRevision, publishUnlessStale } from './GenerationFence';
import {
    LogicalGeneration,
    captureLogicalGeneration,
    isStaleGeneration,
    proxyUrlIdentity,
    sameLogicalIdentity
} from './LogicalGeneration';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import type { ManualFallbackOutcome } from './SystemProxyUpdateService';
import { ProxyMode, ProxyState, ProxyTestResult, stateRevision } from './types';
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
    // One endpoint keeps its verdict however the URL is spelled (#97).
    const sameEndpoint = proxyUrlIdentity(previousProxy) === proxyUrlIdentity(state.autoProxyUrl);
    if (result.proxyUrl) {
        applyEndpointVerdict(state, sameEndpoint, result.testResult);
    }

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
    // Auto: OFF removed the proxy because this endpoint did not answer. The
    // same endpoint without proof that it is alive again says nothing new
    // about that, so whatever else changed (per-scheme URLs, bypass, the URL's
    // spelling) is only saved for the recovery to apply (#93, #97). The
    // Configured flags are false here because of that removal, not because an
    // enable failed. A new unreachable result still goes through apply, which
    // repeats the removal.
    const stillOffWithoutProof =
        Boolean(result.proxyUrl) &&
        sameEndpoint &&
        state.autoModeOff === true &&
        !(result.testResult && isProxyEndpointUnreachable(result.testResult));
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
    if (stillOffWithoutProof || unchanged) {
        await commitAndPublish(context, started, 'detection', current => ({
            ...current,
            autoProxyUrl: state.autoProxyUrl,
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
        // The check's connection test may have left its result to this event (#102).
        context.updateStatusBar?.(await context.proxyStateManager.getState());
        return;
    }

    await saveApplyThenPublish(context, started, 'detection', state, async () => {
        // Nothing enables under Auto: OFF (#97). An engaged fallback was just
        // tested reachable and cleared it; an unreachable result set it.
        const shouldEnable = Boolean(state.autoProxyUrl) && state.autoModeOff !== true;
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

    if (isLeftToProxyChange(testResult.proxyChange, current)) {
        clearStartupPendingIfNeeded(startupTestState, testResult);
        return;
    }

    let recoveredFromAutoOff = false;
    const commit = await commitUnlessStaleWithRevision(context.proxyStateManager, started, 'connectionTest', state => {
        if (state.mode !== ProxyMode.Auto) {
            return undefined;
        }

        const next = { ...state };
        const wasAutoModeOff = next.autoModeOff === true;
        next.lastTestResult = stripGeneration(testResult);
        next.proxyReachable = isProxyEndpointReachable(testResult);
        next.lastTestTimestamp = Date.now();
        applyEndpointVerdict(next, true, testResult);
        recoveredFromAutoOff = wasAutoModeOff && next.autoModeOff === false && Boolean(next.autoProxyUrl);
        // A recovery is published only once its apply finished, as on every
        // other apply path: until then the proxy is not active (#97).
        next.convergencePending = isProxyEndpointUnreachable(testResult) || recoveredFromAutoOff;
        return next;
    });

    if (commit.outcome === 'stale') {
        clearStartupPendingIfNeeded(startupTestState, testResult);
        return;
    }

    const committed = await context.proxyStateManager.getState();
    if (!recoveredFromAutoOff) {
        await publishUnlessStale(context.publishProxyState, captureLogicalGeneration(committed), 'connectionTest', {
            ...committed,
            convergencePending: false
        });
    }
    context.updateStatusBar?.(committed);
    clearStartupPendingIfNeeded(startupTestState, testResult);

    if (isProxyEndpointUnreachable(testResult)) {
        if (!await stateStillFromTest(context, testResult, commit.revision)) {
            return;
        }
        await applyProxyThroughContext(context, '', false, { silent: true });
        return;
    }

    // This test is what proved the endpoint alive, so it applies the proxy in
    // the same step that leaves Auto: OFF (#97). The reachability flip may not
    // follow: the monitor reports it once, possibly for an earlier test.
    if (recoveredFromAutoOff) {
        const latest = await stateStillFromTest(context, testResult, commit.revision);
        if (!latest || latest.autoModeOff !== false || !latest.autoProxyUrl) {
            return;
        }
        await applyProxyThroughContext(context, latest.autoProxyUrl, true, { silent: true });
        Logger.info(`Proxy ${context.sanitizer.maskPassword(latest.autoProxyUrl)} proved reachable, Auto Mode back on`);
        await clearPendingThenPublish(context, 'connectionTest', latest);
        context.updateStatusBar?.(await context.proxyStateManager.getState());
    }
}

/**
 * The state this test's commit wrote, or undefined once a toggle, sync, or
 * detection replaced it. Compared with the revision the commit wrote, not the
 * test's start generation: the commit itself advanced past that. Without an
 * attributable revision (no compare-and-set store), mode and URL decide.
 */
async function stateStillFromTest(
    context: InitializerContext,
    testResult: TestResult,
    committedRevision: number | undefined
): Promise<ProxyState | undefined> {
    const latest = await context.proxyStateManager.getState();
    if (latest.mode !== ProxyMode.Auto) {
        return undefined;
    }
    if (committedRevision !== undefined && stateRevision(latest) !== committedRevision) {
        return undefined;
    }
    if (testResult.proxyUrl && proxyUrlIdentity(testResult.proxyUrl) !== proxyUrlIdentity(latest.autoProxyUrl)) {
        return undefined;
    }
    return latest;
}

export async function handleProxyStateChanged(
    context: InitializerContext,
    data: ReachabilityChange
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

    if (isLeftToProxyChange(data.proxyChange, state)) {
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
    await clearPendingThenPublish(context, owner, desired);
}

/**
 * Ends an apply that started from a state saved with convergencePending:
 * clears the flag and publishes the converged state. A state that moved to
 * another logical identity meanwhile belongs to the writer that moved it.
 * The revision is not compared: the apply itself writes the Configured flags.
 */
async function clearPendingThenPublish(
    context: InitializerContext,
    owner: 'detection' | 'connectionTest' | 'autoMonitoring' | 'stateChanged',
    desired: ProxyState
): Promise<void> {
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

/**
 * Auto: OFF is a verdict about one endpoint (#97), and only proof changes it:
 * proven unreachable turns it on, proven alive turns it off. A test that
 * proves neither, or no test, keeps it for the same endpoint; a new endpoint
 * starts without it, because only proven unreachability turns Auto OFF (#67).
 */
function applyEndpointVerdict(state: ProxyState, sameEndpoint: boolean, testResult: TestResult | undefined): void {
    const verdict = testResult ? proxyEndpointVerdict(testResult) : 'unknown';
    if (verdict === 'unreachable') {
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        Logger.info('Proxy endpoint unreachable - Auto Mode OFF');
        return;
    }

    if (verdict === 'alive' || (!sameEndpoint && state.autoModeOff === true)) {
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
    data: ReachabilityChange
): Promise<void> {
    if (data.reachable && !data.previousState) {
        if (state.autoModeOff === true) {
            // "Not proven unreachable" is not proof of life. The connection
            // test that raised this flip owns the Auto: OFF verdict (#97).
            await commitAndPublish(context, started, 'stateChanged', current => ({
                ...current,
                proxyReachable: true
            }));
            context.updateStatusBar?.(await context.proxyStateManager.getState());
            return;
        }

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
        return isStaleGeneration(started, current) || isTestOfAnotherEndpoint(testResult, current);
    }

    if (current.mode !== ProxyMode.Auto) {
        return true;
    }

    return isTestOfAnotherEndpoint(testResult, current);
}

/**
 * The verdict belongs to the endpoint the test reached. A test of a new
 * endpoint precedes the proxyChanged event that owns it; committing it here
 * would advance the revision and make that event stale (#97).
 */
function isTestOfAnotherEndpoint(testResult: TestResult, current: ProxyState): boolean {
    return Boolean(testResult.proxyUrl) &&
        proxyUrlIdentity(testResult.proxyUrl) !== proxyUrlIdentity(current.autoProxyUrl);
}

/**
 * The check that ran this test, or flipped this reachability, reports
 * proxyChanged next, and that event will both pass the generation fence and
 * change this endpoint's per-scheme URLs or bypass. It carries the test result
 * and applies the verdict together with the routing (#102). A commit here
 * would advance the revision first and make it stale, and the monitor does
 * not report the change twice. A new endpoint is left to it by
 * isTestOfAnotherEndpoint (#97).
 */
function isLeftToProxyChange(change: ReportedProxyChange | undefined, current: ProxyState): boolean {
    return change !== undefined &&
        !isStaleGeneration(change.startedGeneration, current) &&
        change.routing !== splitRoutingIdentity(current);
}

function stripGeneration(testResult: TestResult): ProxyTestResult {
    const { startedGeneration: _started, proxyChange: _change, ...rest } = testResult;
    return rest as ProxyTestResult;
}
