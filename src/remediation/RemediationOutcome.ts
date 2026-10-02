import type { ProxyApplyDetailedResult, ProxyConfigResults, ProxyTargetOutcome } from '../core/ProxyApplierTypes';
import type { ProxyIssue } from '../core/v3Types';

/**
 * Why one apply request (first attempt plus at most one bounded retry) stopped.
 * Exactly one reason per request, so diagnostics can say where remediation ended
 * instead of leaving the user to infer it from booleans (#78).
 */
export type RemediationStopReason =
    /** Writes succeeded and fresh diagnostics saw no convergence blocker. */
    | 'converged'
    /** Writes succeeded but no fresh diagnostics were available to confirm convergence. */
    | 'unverified'
    /** A credential-bearing write needs consent on this machine; nothing was written. */
    | 'consentRequired'
    /** Another window kept the apply lock past the bounded wait; nothing was written. */
    | 'lockSkipped'
    /** A newer logical generation replaced this request; its remaining attempts were dropped. */
    | 'superseded'
    /** A retryable failure or blocker remained, but automatic remediation or retry is disabled. */
    | 'retryDisabled'
    /** The remaining failure or blocker is not one that automatic retry handles. */
    | 'notRetryable'
    /** The flap tracker refused the retry (attempt window or cooldown). */
    | 'flapSuppressed'
    /** The single bounded retry ran and the failure or blocker remained. */
    | 'retryExhausted';

export type RemediationTarget = 'git' | 'vscode' | 'npm' | 'pip' | 'terminalEnv';

/**
 * Secret-free terminal record of one apply request. Holds enums, target names,
 * error types and issue ids only: error messages and observed values can carry
 * proxy URLs with credentials, so they are never copied here.
 */
export interface RemediationOutcome {
    /** Monotonic per window; a lower attempt never replaces a higher one. */
    attempt: number;
    trigger: string;
    finishedAt: number;
    desiredEnabled: boolean;
    /** The value returned to the caller (unchanged caller contract). */
    success: boolean;
    /** Fresh observation: true only when diagnostics saw no blocker; undefined when not observed. */
    converged: boolean | undefined;
    stopReason: RemediationStopReason;
    retryAttempted: boolean;
    retrySuppressed: boolean;
    lockSkipped: boolean;
    superseded: boolean;
    targetOutcomes: Partial<Record<RemediationTarget, ProxyTargetOutcome>>;
    errorTypes: string[];
    remainingBlockerIds: string[];
}

export interface RemediationOutcomeInput {
    attempt: number;
    trigger: string;
    finishedAt: number;
    desiredEnabled: boolean;
    success: boolean;
    applyResult?: ProxyApplyDetailedResult;
    /** Fresh issues after the last attempt; undefined when diagnostics were unavailable. */
    observedIssues?: readonly ProxyIssue[];
    retryAttempted: boolean;
    retrySuppressed: boolean;
    lockSkipped: boolean;
    consentDenied: boolean;
    /** The remaining failure or blocker is of a kind automatic retry would handle. */
    retryableFailure: boolean;
    /** automaticRemediationEnabled && automaticRetryEnabled. */
    retryEnabled: boolean;
}

export function classifyStopReason(input: RemediationOutcomeInput): RemediationStopReason {
    if (input.consentDenied) {
        return 'consentRequired';
    }
    if (input.lockSkipped) {
        return 'lockSkipped';
    }
    if (input.applyResult?.superseded) {
        return 'superseded';
    }

    const blockers = blockingIssues(input.observedIssues);
    const unresolved = !input.applyResult?.success || blockers.length > 0;
    if (!unresolved) {
        return input.observedIssues ? 'converged' : 'unverified';
    }
    if (input.retryAttempted) {
        return 'retryExhausted';
    }
    if (input.retrySuppressed) {
        return 'flapSuppressed';
    }
    if (input.retryableFailure && !input.retryEnabled) {
        return 'retryDisabled';
    }
    return 'notRetryable';
}

export function buildRemediationOutcome(input: RemediationOutcomeInput): RemediationOutcome {
    const blockers = blockingIssues(input.observedIssues);
    const writesSucceeded = Boolean(input.applyResult?.success) && !input.applyResult?.superseded;
    return {
        attempt: input.attempt,
        trigger: input.trigger,
        finishedAt: input.finishedAt,
        desiredEnabled: input.desiredEnabled,
        success: input.success,
        converged: input.observedIssues ? writesSucceeded && blockers.length === 0 : undefined,
        stopReason: classifyStopReason(input),
        retryAttempted: input.retryAttempted,
        retrySuppressed: input.retrySuppressed,
        lockSkipped: input.lockSkipped,
        superseded: Boolean(input.applyResult?.superseded),
        targetOutcomes: input.applyResult ? targetOutcomes(input.applyResult.results) : {},
        errorTypes: [...new Set(
            (input.applyResult?.errors ?? [])
                .map(error => error.errorType)
                .filter((errorType): errorType is string => typeof errorType === 'string')
        )],
        remainingBlockerIds: blockers.map(issue => issue.id)
    };
}

function blockingIssues(issues: readonly ProxyIssue[] | undefined): ProxyIssue[] {
    return (issues ?? []).filter(issue => issue.impact === 'blocksConvergence');
}

function targetOutcomes(results: ProxyConfigResults): Partial<Record<RemediationTarget, ProxyTargetOutcome>> {
    const outcomes: Partial<Record<RemediationTarget, ProxyTargetOutcome>> = {};
    const entries: Array<[RemediationTarget, ProxyTargetOutcome | undefined]> = [
        ['git', results.gitOutcome],
        ['vscode', results.vscodeOutcome],
        ['npm', results.npmOutcome],
        ['pip', results.pipOutcome],
        ['terminalEnv', results.terminalEnvOutcome]
    ];
    for (const [target, outcome] of entries) {
        if (outcome) {
            outcomes[target] = outcome;
        }
    }
    return outcomes;
}
