import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyConfigResults } from './ProxyApplierTypes';

export async function saveProxyConfigResults(
    stateManager: ProxyStateManager | undefined,
    results: ProxyConfigResults,
    errorAggregator: ErrorAggregator
): Promise<void> {
    if (!stateManager) {
        return;
    }

    try {
        const state = await stateManager.getState();
        state.gitConfigured = results.gitSuccess;
        state.vscodeConfigured = results.vscodeSuccess;
        state.npmConfigured = results.npmSuccess;
        state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
        await stateManager.saveState(state);
    } catch (error) {
        Logger.error('Failed to update configuration state tracking:', error);
    }
}
