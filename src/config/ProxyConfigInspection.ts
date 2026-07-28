export type ProxyConfigReadStatus = 'available' | 'unavailable' | 'error';

/**
 * Read result used before destructive cleanup. `available` includes both
 * configured values and an idempotently absent value. Callers must never turn
 * `unavailable` or `error` into permission to delete blindly.
 */
export interface ProxyConfigInspection<TValues> {
    status: ProxyConfigReadStatus;
    values?: TValues;
    error?: string;
    errorType?: string;
}
