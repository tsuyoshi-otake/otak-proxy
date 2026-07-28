import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import {
    ProxyConfigOperationOptions,
    ProxyConfigTarget,
    ProxyConfigTargetUpdateResult
} from './ProxyApplierTypes';

const OPTIONAL_EXTERNAL_TOOL_TARGETS = new Set([
    'Git configuration',
    'npm configuration',
    'pip configuration'
]);

function isOptionalToolMissing(target: ProxyConfigTarget, errorType?: string): boolean {
    return errorType === 'NOT_INSTALLED' && OPTIONAL_EXTERNAL_TOOL_TARGETS.has(target.name);
}

export async function updateProxyConfigTarget(
    target: ProxyConfigTarget,
    enabled: boolean,
    proxyUrl: string,
    errorAggregator: ErrorAggregator,
    options?: ProxyConfigOperationOptions
): Promise<boolean> {
    return (await updateProxyConfigTargetDetailed(
        target,
        enabled,
        proxyUrl,
        errorAggregator,
        options
    )).success;
}

export async function updateProxyConfigTargetDetailed(
    target: ProxyConfigTarget,
    enabled: boolean,
    proxyUrl: string,
    errorAggregator: ErrorAggregator,
    options?: ProxyConfigOperationOptions
): Promise<ProxyConfigTargetUpdateResult> {
    try {
        const result = enabled
            ? await target.manager.setProxy(proxyUrl, options)
            : await target.manager.unsetProxy(options);

        if (!result.success) {
            if (isOptionalToolMissing(target, result.errorType)) {
                Logger.info(`${target.name} skipped:`, result.error);
                return { success: true, outcome: 'skippedUnavailable', errorType: result.errorType };
            }

            Logger.error(`${target.name} failed:`, result.error, result.errorType);
            errorAggregator.addError(target.name, result.error || `Failed to update ${target.name}`);
            return { success: false, outcome: 'failed', errorType: result.errorType };
        }

        return { success: true, outcome: enabled ? 'configured' : 'cleared' };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error(`${target.name} error:`, error);
        errorAggregator.addError(target.name, errorMsg);
        return { success: false, outcome: 'failed' };
    }
}
