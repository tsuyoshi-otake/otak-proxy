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
        state.gitConfigured = nextConfiguredState(state.gitConfigured, results.gitSuccess, enabled);
        state.vscodeConfigured = nextConfiguredState(state.vscodeConfigured, results.vscodeSuccess, enabled);
        state.npmConfigured = nextConfiguredState(state.npmConfigured, results.npmSuccess, enabled);
        if (typeof results.pipSuccess === 'boolean') {
            state.pipConfigured = nextConfiguredState(state.pipConfigured, results.pipSuccess, enabled);
        }
        state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
        await stateManager.saveState(state);
    } catch (error) {
        Logger.error('Failed to update configuration state tracking:', error);
    }
}

function nextConfiguredState(previous: boolean | undefined, success: boolean, enabled: boolean): boolean | undefined {
    if (!success) {
        return previous;
    }

    return enabled;
}
