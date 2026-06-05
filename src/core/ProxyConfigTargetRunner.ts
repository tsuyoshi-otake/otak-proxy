import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import { ProxyConfigOperationOptions, ProxyConfigTarget } from './ProxyApplierTypes';

export async function updateProxyConfigTarget(
    target: ProxyConfigTarget,
    enabled: boolean,
    proxyUrl: string,
    errorAggregator: ErrorAggregator,
    options?: ProxyConfigOperationOptions
): Promise<boolean> {
    try {
        const result = enabled
            ? await target.manager.setProxy(proxyUrl, options)
            : await target.manager.unsetProxy(options);

        if (!result.success) {
            Logger.error(`${target.name} failed:`, result.error, result.errorType);
            errorAggregator.addError(target.name, result.error || `Failed to update ${target.name}`);
            return false;
        }

        return true;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error(`${target.name} error:`, error);
        errorAggregator.addError(target.name, errorMsg);
        return false;
    }
}
