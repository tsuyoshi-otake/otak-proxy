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

/**
 * Factor applied to the polling and connection-test intervals while the window
 * is not focused.
 *
 * Nobody is looking at the status bar of a background window, so the only cost
 * of a slower cadence there is that the first check after refocusing may be
 * slightly staler - and refocusing already triggers an immediate check. In
 * exchange, background windows stop spawning registry queries and HTTP
 * connection tests at full rate, which is what dominates idle CPU when several
 * windows are open.
 */
const UNFOCUSED_INTERVAL_MULTIPLIER = 4;

/**
 * Derives the intervals actually used for the current window focus state.
 *
 * Returns the base configuration untouched while focused, so focused behavior
 * is bit-for-bit identical to the configured values.
 */
export function deriveEffectiveProxyMonitorConfig(
    baseConfig: ProxyMonitorConfig,
    windowFocused: boolean
): ProxyMonitorConfig {
    if (windowFocused) {
        return baseConfig;
    }

    // Clamped rather than normalized so backing off never emits the
    // out-of-range warning that a user-supplied value would.
    const pollingInterval = Math.min(
        baseConfig.pollingInterval * UNFOCUSED_INTERVAL_MULTIPLIER,
        MAX_POLLING_INTERVAL
    );
    // Scale both intervals by whatever factor the clamp actually allowed, so
    // their relative order (which decides scheduler vs inline testing) is the
    // same as when focused.
    const appliedFactor = pollingInterval / baseConfig.pollingInterval;

    return {
        ...baseConfig,
        pollingInterval,
        connectionTestInterval: Math.round(baseConfig.connectionTestInterval * appliedFactor)
    };
}

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
