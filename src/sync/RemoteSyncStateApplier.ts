import { commitDecidedPatch } from '../core/ApplyConvergence';
import { captureLogicalGeneration, sameLogicalIdentity } from '../core/LogicalGeneration';
import { AppliedPlan, proxyApplyPlanUrls, resolveProxyApplyOptions, sameAppliedPlan } from '../core/ProxyApplyPlan';
import { ProxyMode, ProxyState, StateCommitResult } from '../core/types';
import { Logger } from '../utils/Logger';
import {
    shouldSkipUnauthenticatedApply,
    UNRESOLVED_LOCAL_CREDENTIAL_ERROR
} from '../utils/ProxyStateSanitizer';

export interface RemoteSyncApplyContext {
    saveState(state: ProxyState): Promise<void>;
    getState(): Promise<ProxyState>;
    /**
     * Revision-checked commit (#108). Required: the context must satisfy
     * `DecidedPatchWriter`, so the credential gate's bookkeeping write can be
     * folded onto the latest state — a newer logical state moves the gate to
     * `moved`, while a revision-only commit is refolded instead of dropping
     * monitoring and status.
     */
    commitState(expectedRevision: number, next: ProxyState): Promise<StateCommitResult>;
    getActiveProxyUrl(state: ProxyState): string;
    applyProxy(url: string, enabled: boolean): Promise<boolean>;
    startMonitoring(): Promise<void>;
    stopMonitoring(): Promise<void>;
    updateStatus(state: ProxyState): void;
    onApplyFailure?(): void;
    /**
     * Resolves to the outcome of this delivery's adoption, which the
     * SyncManager already decided at emission on the transition section
     * (#108). False means the delivery was superseded by a newer local
     * publication or adoption, in which case nothing may be saved or
     * applied. Without the hook, the receiver saves directly (tests and
     * standalone use).
     */
    adoptRemoteState?(): Promise<boolean>;
    /** The last plan this window verifiably applied, if any (#108). */
    lastAppliedPlan?(): AppliedPlan | undefined;
    /** True while one of this window's own apply attempts is still running. */
    isApplyInFlight?(): boolean;
}

/**
 * Applies a remote desired state to this window. Auto OFF is an explicit local
 * disable terminal state, not an empty-URL no-op. The returned boolean lets the
 * caller observe convergence failure even when user notifications are silent.
 *
 * Cross-window ordering is the shared file's version, owned by the SyncManager
 * (#108): this function never compares the local and remote `revision`
 * counters, which are per-window numbers. An adoption superseded under the
 * version order reports false without saving, applying, touching monitoring
 * or the status bar, or reporting an apply failure.
 *
 * The apply itself is skipped when this window's own apply record proves the
 * same plan was already written (and no attempt is in flight); monitoring
 * and the status bar still follow the adopted mode.
 *
 * The returned boolean describes this delivery: it is false when the
 * delivery was superseded, when the apply failed, or when the delivery
 * itself was published with `convergencePending`. Everything else in the
 * convergence works from the window's current local state (#108).
 */
export async function applyRemoteSyncState(
    remoteState: ProxyState,
    context: RemoteSyncApplyContext
): Promise<boolean> {
    const adopted = context.adoptRemoteState
        ? await context.adoptRemoteState()
        : await context.saveState({ ...remoteState }).then(() => true);
    if (!adopted) {
        return false;
    }

    const localState = await context.getState();
    const activeUrl = context.getActiveProxyUrl(localState);

    const planOptions = activeUrl ? resolveProxyApplyOptions(activeUrl, undefined, localState) : undefined;
    if (shouldSkipUnauthenticatedApply(localState, proxyApplyPlanUrls(activeUrl, planOptions))) {
        // The bookkeeping write folds onto the latest state (#108): a newer
        // logical state (a later delivery's adoption, a local commit) moves
        // the gate — its owner converges it — while a revision-only commit
        // (a connection-test result, the monitoring start's proxyReachable
        // reset) is refolded instead of dropping monitoring and status.
        const gateGeneration = captureLogicalGeneration(localState);
        const recorded = await commitDecidedPatch(
            context,
            { lastError: UNRESOLVED_LOCAL_CREDENTIAL_ERROR, proxyReachable: false },
            latest => sameLogicalIdentity(gateGeneration, captureLogicalGeneration(latest))
        );
        if (recorded.kind === 'moved') {
            Logger.log(
                'Remote sync credential gate: a newer logical state superseded the read; ' +
                'its owner applies it and updates monitoring and the status bar.'
            );
            return false;
        }
        if (recorded.kind === 'exhausted') {
            Logger.warn('Could not record the credential-gate error on the latest state (CAS exhausted); continuing');
        }
        if (localState.mode === ProxyMode.Auto) {
            await context.startMonitoring();
        } else {
            await context.stopMonitoring();
        }
        context.updateStatus(await context.getState());
        context.onApplyFailure?.();
        return false;
    }

    const shouldEnable = localState.mode !== ProxyMode.Off && Boolean(activeUrl);
    const desired: AppliedPlan = {
        enabled: shouldEnable,
        url: shouldEnable ? activeUrl : '',
        plan: {
            kind: planOptions?.kind,
            httpUrl: planOptions?.httpUrl,
            httpsUrl: planOptions?.httpsUrl,
            bypass: planOptions?.bypass
        }
    };
    // The record is this window's own fact: remote lastError/targetOutcomes
    // fields say what the publisher's machine did, not this one (#108).
    const record = context.lastAppliedPlan?.();
    const alreadyApplied = context.isApplyInFlight?.() !== true &&
        record !== undefined &&
        sameAppliedPlan(record, desired);
    const applied = alreadyApplied || await context.applyProxy(shouldEnable ? activeUrl : '', shouldEnable);

    if (localState.mode === ProxyMode.Auto) {
        await context.startMonitoring();
    } else {
        await context.stopMonitoring();
    }

    context.updateStatus(await context.getState());
    if (!applied || remoteState.convergencePending) {
        if (!applied) {
            context.onApplyFailure?.();
        }
        return false;
    }
    return applied;
}
