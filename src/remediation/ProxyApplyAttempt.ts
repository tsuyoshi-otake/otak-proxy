import { AppliedPlanTracker } from '../core/AppliedPlanTracker';
import { commitUnlessStale, createFencedApply, StateWriter } from '../core/GenerationFence';
import { captureLogicalGeneration } from '../core/LogicalGeneration';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { AppliedPlan, proxyApplyPlanUrls, resolveProxyApplyOptions } from '../core/ProxyApplyPlan';
import { Logger } from '../utils/Logger';
import {
    planUrlsMissingRequiredCredentials,
    UNRESOLVED_LOCAL_CREDENTIAL_ERROR
} from '../utils/ProxyStateSanitizer';
import { RemediationStopReason } from './RemediationOutcome';
import {
    ProxyApplyDetailedDelegate,
    ProxyApplyTrigger,
    ProxyRemediationService
} from './ProxyRemediationService';

/**
 * One proxy apply attempt reads the state exactly once.
 *
 * That single read captures the logical generation the apply fence guards
 * AND resolves the write plan (per-scheme URLs plus bypass), so consent,
 * `otakProxy.credentialTargetPolicy` and the applier all share the same
 * plan: the URLs consent judged are exactly the URLs written, and retries
 * reuse the plan (#108). The applier never resolves a plan itself.
 */

/** What callers and tests need back from one apply attempt. */
export interface ProxyApplyAttemptResult {
    success: boolean;
    applyResult?: ProxyApplyDetailedResult;
    stopReason?: RemediationStopReason;
}

function appliedPlanPart(plan: ProxyApplyOptions | undefined): AppliedPlan['plan'] {
    return {
        kind: plan?.kind,
        httpUrl: plan?.httpUrl,
        httpsUrl: plan?.httpsUrl,
        bypass: plan?.bypass
    };
}

/**
 * Runs one apply attempt: one `getState()`, then either the remediation
 * service (consent, policy, retries) or — when no service is wired — the
 * fenced apply directly, both over the same resolved plan.
 *
 * `appliedPlanTracker` (optional, from the composition root) records the
 * attempt's inputs only when it succeeded and wrote them (`success`, a
 * successful `applyResult`, not `superseded`); every other outcome —
 * credential-gate refusal, consent denial, lock skip, supersede, retries
 * suppressed or exhausted, a thrown error — clears the record (#108).
 */
export async function runProxyApplyAttempt(
    stateWriter: StateWriter,
    applyDetailed: ProxyApplyDetailedDelegate,
    remediationService: Pick<ProxyRemediationService, 'applyWithSafety'> | undefined,
    url: string,
    enabled: boolean,
    trigger: ProxyApplyTrigger,
    options?: ProxyApplyOptions,
    appliedPlanTracker?: AppliedPlanTracker
): Promise<ProxyApplyAttemptResult> {
    appliedPlanTracker?.noteAttemptStarted();
    let applied: AppliedPlan | undefined;
    try {
        const state = await stateWriter.getState();
        const generation = captureLogicalGeneration(state);
        const plan = enabled && url
            ? resolveProxyApplyOptions(url, options, state)
            : options;

        if (enabled && url) {
            // The per-address rule only. The aggregate `requiresAuth` check must
            // not run here: it is derived from all six URL fields, so it would
            // also refuse a credential-free plan merely because an unrelated
            // field (the manual fallback, say) carries credentials (#108).
            const missing = planUrlsMissingRequiredCredentials(state, proxyApplyPlanUrls(url, plan));
            if (missing.length > 0) {
                Logger.warn(
                    `Skipping proxy apply: credentials for ${missing.join(', ')} are unavailable on this machine.`
                );
                // Reachability stays as the connection test's verdict: the
                // address is reachable, it only lacks its credentials.
                await commitUnlessStale(stateWriter, generation, 'applyResults', current => ({
                    ...current,
                    lastError: UNRESOLVED_LOCAL_CREDENTIAL_ERROR
                }));
                return { success: false };
            }
        }

        const fencedApply = createFencedApply(
            stateWriter,
            generation,
            trigger,
            applyDetailed
        );

        const result = !remediationService
            ? await runAttemptWithoutRemediation(fencedApply, url, enabled, plan)
            : await remediationService.applyWithSafety(url, enabled, { ...plan, trigger }, fencedApply)
                .then(r => ({
                    success: r.success,
                    applyResult: r.applyResult,
                    stopReason: r.outcome.stopReason
                }));

        if (result.success && result.applyResult?.success === true && !result.applyResult.superseded) {
            applied = { enabled, url, plan: appliedPlanPart(plan) };
        }
        return result;
    } finally {
        appliedPlanTracker?.noteAttemptFinished(applied);
    }
}

async function runAttemptWithoutRemediation(
    fencedApply: ReturnType<typeof createFencedApply>,
    url: string,
    enabled: boolean,
    plan: ProxyApplyOptions | undefined
): Promise<ProxyApplyAttemptResult> {
    const applyResult = await fencedApply(url, enabled, plan);
    return { success: applyResult.success, applyResult };
}
