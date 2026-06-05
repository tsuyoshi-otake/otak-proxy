import { Logger } from '../utils/Logger';
import { ProxyMonitorConfig } from './ProxyMonitorTypes';

const MIN_POLLING_INTERVAL = 10000;
const MAX_POLLING_INTERVAL = 300000;

export const DEFAULT_PROXY_MONITOR_CONFIG: ProxyMonitorConfig = {
    pollingInterval: 30000,
    debounceDelay: 1000,
    maxRetries: 3,
    retryBackoffBase: 1,
    detectionSourcePriority: ['environment', 'vscode', 'platform'],
    enableConnectionTest: true,
    connectionTestInterval: 60000
};

export function normalizeProxyMonitorConfig(config: ProxyMonitorConfig): ProxyMonitorConfig {
    const normalized = { ...config };

    if (normalized.pollingInterval < MIN_POLLING_INTERVAL) {
        Logger.warn(`Polling interval ${normalized.pollingInterval}ms is below minimum, using ${MIN_POLLING_INTERVAL}ms`);
        normalized.pollingInterval = MIN_POLLING_INTERVAL;
    }

    if (normalized.pollingInterval > MAX_POLLING_INTERVAL) {
        Logger.warn(`Polling interval ${normalized.pollingInterval}ms is above maximum, using ${MAX_POLLING_INTERVAL}ms`);
        normalized.pollingInterval = MAX_POLLING_INTERVAL;
    }

    if (normalized.maxRetries < 0) {
        normalized.maxRetries = 0;
    }

    if (normalized.retryBackoffBase <= 0) {
        normalized.retryBackoffBase = 1;
    }

    return normalized;
}
