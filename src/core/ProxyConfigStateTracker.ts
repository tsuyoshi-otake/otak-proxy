import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import { commitUnlessStaleWithRevision } from './GenerationFence';
import { LogicalGeneration, captureLogicalGeneration } from './LogicalGeneration';
import { ProxyState } from './types';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyConfigResults } from './ProxyApplierTypes';

/**
 * Records per-target results for the generation the apply started under.
 * Returns the revision this call wrote, or undefined when nothing attributable
 * was written (no state manager, stale generation, non-CAS writer, or error).
 */
export async function saveProxyConfigResults(
    stateManager: ProxyStateManager | undefined,
    enabled: boolean,
    results: ProxyConfigResults,
    errorAggregator: ErrorAggregator,
    started?: LogicalGeneration,
    applyBlocked?: ProxyState['applyBlocked']
): Promise<number | undefined> {
    if (!stateManager) {
        return undefined;
    }

    try {
        const generation = started ?? captureLogicalGeneration(await stateManager.getState());
        const commit = await commitUnlessStaleWithRevision(stateManager, generation, 'applyResults', state => {
        const next = { ...state };
        next.gitConfigured = nextConfiguredState(state.gitConfigured, results.gitSuccess, enabled, results.gitOutcome);
        next.vscodeConfigured = nextConfiguredState(state.vscodeConfigured, results.vscodeSuccess, enabled, results.vscodeOutcome);
        next.npmConfigured = nextConfiguredState(state.npmConfigured, results.npmSuccess, enabled, results.npmOutcome);
        if (typeof results.pipSuccess === 'boolean') {
            next.pipConfigured = nextConfiguredState(
                state.pipConfigured,
                results.pipSuccess,
                enabled,
                results.pipOutcome
            );
        }
        next.terminalEnvConfigured = nextConfiguredState(
            state.terminalEnvConfigured,
            results.terminalEnvSuccess,
            enabled,
            results.terminalEnvOutcome
        );
        next.targetOutcomes = {
            ...state.targetOutcomes,
            git: results.gitOutcome,
            vscode: results.vscodeOutcome,
            npm: results.npmOutcome,
            pip: results.pipOutcome,
            terminalEnv: results.terminalEnvOutcome
        };
            next.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
            next.applyBlocked = applyBlocked;
            return next;
        });
        if (commit.outcome === 'stale') {
            Logger.warn('Discarding stale apply-result write; a newer generation already owns disk.');
        }
        return commit.revision;
    } catch (error) {
        Logger.error('Failed to update configuration state tracking:', error);
        return undefined;
    }
}

function nextConfiguredState(
    previous: boolean | undefined,
    success: boolean,
    enabled: boolean,
    outcome?: ProxyConfigResults['gitOutcome']
): boolean | undefined {
    if (!success || outcome === 'failed' || outcome === 'skippedUnavailable') {
        return previous;
    }

    if (outcome === 'preservedExternal') {
        return false;
    }

    return enabled;
}
