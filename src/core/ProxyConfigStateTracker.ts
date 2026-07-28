import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyConfigResults } from './ProxyApplierTypes';

export async function saveProxyConfigResults(
    stateManager: ProxyStateManager | undefined,
    enabled: boolean,
    results: ProxyConfigResults,
    errorAggregator: ErrorAggregator
): Promise<void> {
    if (!stateManager) {
        return;
    }

    try {
        const state = await stateManager.getState();
        state.gitConfigured = nextConfiguredState(state.gitConfigured, results.gitSuccess, enabled, results.gitOutcome);
        state.vscodeConfigured = nextConfiguredState(state.vscodeConfigured, results.vscodeSuccess, enabled, results.vscodeOutcome);
        state.npmConfigured = nextConfiguredState(state.npmConfigured, results.npmSuccess, enabled, results.npmOutcome);
        if (typeof results.pipSuccess === 'boolean') {
            state.pipConfigured = nextConfiguredState(
                state.pipConfigured,
                results.pipSuccess,
                enabled,
                results.pipOutcome
            );
        }
        state.terminalEnvConfigured = nextConfiguredState(
            state.terminalEnvConfigured,
            results.terminalEnvSuccess,
            enabled,
            results.terminalEnvOutcome
        );
        state.targetOutcomes = {
            ...state.targetOutcomes,
            git: results.gitOutcome,
            vscode: results.vscodeOutcome,
            npm: results.npmOutcome,
            pip: results.pipOutcome,
            terminalEnv: results.terminalEnvOutcome
        };
        state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
        await stateManager.saveState(state);
    } catch (error) {
        Logger.error('Failed to update configuration state tracking:', error);
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
