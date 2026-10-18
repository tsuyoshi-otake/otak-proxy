import { createFencedApply } from '../core/GenerationFence';
import { captureLogicalGeneration } from '../core/LogicalGeneration';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { resolveProxyApplyOptions } from '../core/ProxyApplyPlan';
import { IProxyStateManager } from '../core/types';
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

/**
 * Runs one apply attempt: one `getState()`, then either the remediation
 * service (consent, policy, retries) or — when no service is wired — the
 * fenced apply directly, both over the same resolved plan.
 */
export async function runProxyApplyAttempt(
    stateReader: Pick<IProxyStateManager, 'getState'>,
    applyDetailed: ProxyApplyDetailedDelegate,
    remediationService: Pick<ProxyRemediationService, 'applyWithSafety'> | undefined,
    url: string,
    enabled: boolean,
    trigger: ProxyApplyTrigger,
    options?: ProxyApplyOptions
): Promise<ProxyApplyAttemptResult> {
    const state = await stateReader.getState();
    const plan = enabled && url
        ? resolveProxyApplyOptions(url, options, state)
        : options;
    const fencedApply = createFencedApply(
        stateReader,
        captureLogicalGeneration(state),
        trigger,
        applyDetailed
    );

    if (!remediationService) {
        const applyResult = await fencedApply(url, enabled, plan);
        return { success: applyResult.success, applyResult };
    }

    const result = await remediationService.applyWithSafety(url, enabled, { ...plan, trigger }, fencedApply);
    return {
        success: result.success,
        applyResult: result.applyResult,
        stopReason: result.outcome.stopReason
    };
}
