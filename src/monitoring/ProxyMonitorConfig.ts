import { Logger } from '../utils/Logger';
import { ProxyMonitorConfig } from './ProxyMonitorTypes';

const MIN_POLLING_INTERVAL = 10000;
const MAX_POLLING_INTERVAL = 300000;
const MAX_RETRIES_LIMIT = 10;

/**
 * Range of the connection-test interval in milliseconds (the `testInterval`
 * setting, 30 to 600 seconds). `ProxyTestScheduler` imports it: the scheduler
 * keeps its own clamp because an unfocused window scales the interval past the
 * maximum.
 */
export const MIN_CONNECTION_TEST_INTERVAL = 30000;
export const MAX_CONNECTION_TEST_INTERVAL = 600000;

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

/**
 * Converts a seconds setting to milliseconds. A value that is not a number
 * (VS Code does not enforce the declared type of a machine-overridable setting
 * that a workspace file supplies) becomes NaN instead of being coerced, so
 * `"60"` falls back to the default like any other bad value.
 */
export function settingSecondsToMs(value: unknown): number {
    return typeof value === 'number' ? value * 1000 : NaN;
}

function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampWithWarning(value: number, min: number, max: number, label: string): number {
    if (value < min) {
        Logger.warn(`${label} ${value}ms is below minimum, using ${min}ms`);
        return min;
    }
    if (value > max) {
        Logger.warn(`${label} ${value}ms is above maximum, using ${max}ms`);
        return max;
    }
    return value;
}

/**
 * The one owner of the monitor settings' validity: every reader hands its raw
 * value here (constructor and `updateConfig`). A non-number or non-finite
 * value becomes the documented default, every interval and count is clamped to
 * its documented range, and `maxRetries` is a whole number (floor, so
 * `attempt === maxRetries` can match). `debounceDelay` and `retryBackoffBase`
 * are not user settings: a non-finite or non-positive value becomes the default.
 */
export function normalizeProxyMonitorConfig(config: ProxyMonitorConfig): ProxyMonitorConfig {
    const defaults = DEFAULT_PROXY_MONITOR_CONFIG;
    const normalized = { ...config };

    normalized.pollingInterval = clampWithWarning(
        finiteOr(config.pollingInterval, defaults.pollingInterval),
        MIN_POLLING_INTERVAL,
        MAX_POLLING_INTERVAL,
        'Polling interval'
    );
    normalized.connectionTestInterval = clampWithWarning(
        finiteOr(config.connectionTestInterval, defaults.connectionTestInterval),
        MIN_CONNECTION_TEST_INTERVAL,
        MAX_CONNECTION_TEST_INTERVAL,
        'Connection test interval'
    );
    normalized.maxRetries = Math.min(
        MAX_RETRIES_LIMIT,
        Math.max(0, Math.floor(finiteOr(config.maxRetries, defaults.maxRetries)))
    );

    const debounceDelay = finiteOr(config.debounceDelay, defaults.debounceDelay);
    normalized.debounceDelay = debounceDelay > 0 ? debounceDelay : defaults.debounceDelay;
    const retryBackoffBase = finiteOr(config.retryBackoffBase, defaults.retryBackoffBase);
    normalized.retryBackoffBase = retryBackoffBase > 0 ? retryBackoffBase : defaults.retryBackoffBase;

    return normalized;
}
