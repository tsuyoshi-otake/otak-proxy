/**
 * MonitoringStatus - Represents the current state of proxy monitoring
 * Used to track the status of the proxy detection process
 */
export interface MonitoringStatus {
    isActive: boolean;
    lastCheckTime: number | null;
    lastSuccessTime: number | null;
    lastFailureTime: number | null;
    consecutiveFailures: number;
    currentProxy: string | null;
    detectionSource: string | null;
}

/**
 * ProxyMonitorState - Manages the monitoring state for proxy detection
 *
 * This class provides thread-safe state management for:
 * - Tracking whether monitoring is active
 * - Recording check timestamps (start, success, failure)
 * - Managing consecutive failure count
 * - Storing current proxy and detection source
 *
 * Requirements covered:
 * - 1.3: Error logging and continued polling after failures
 * - 3.1: Retry count management
 * - 3.4: Reset on success
 */
export class ProxyMonitorState {
    private status: MonitoringStatus;

    constructor() {
        this.status = {
            isActive: false,
            lastCheckTime: null,
            lastSuccessTime: null,
            lastFailureTime: null,
            consecutiveFailures: 0,
            currentProxy: null,
            detectionSource: null
        };
    }

    /**
     * Sets the monitoring active state
     * @param active - Whether monitoring is active
     */
    setActive(active: boolean): void {
        this.status.isActive = active;
    }

    /**
     * Records the start of a check operation
     * Updates lastCheckTime to current timestamp
     */
    recordCheckStart(): void {
        this.status.lastCheckTime = Date.now();
    }

    /**
     * Records a successful check operation
     * Updates success timestamp, current proxy, detection source
     * Resets consecutive failure count to 0
     *
     * @param proxyUrl - The detected proxy URL (or null if no proxy)
     * @param source - The detection source (e.g., 'environment', 'vscode', 'platform')
     */
    recordCheckSuccess(proxyUrl: string | null, source: string | null): void {
        this.status.lastSuccessTime = Date.now();
        this.status.currentProxy = proxyUrl;
        this.status.detectionSource = source;
        this.status.consecutiveFailures = 0;
    }

    /**
     * Records a failed check operation
     * Increments consecutive failure count
     * Updates lastFailureTime
     */
    recordCheckFailure(): void {
        this.status.consecutiveFailures++;
        this.status.lastFailureTime = Date.now();
    }

    /**
     * Resets the consecutive failure count to 0
     * Used when explicitly resetting state
     */
    resetFailureCount(): void {
        this.status.consecutiveFailures = 0;
    }

    /**
     * Gets a copy of the current monitoring status
     * Returns a new object to ensure immutability
     *
     * @returns Copy of the current MonitoringStatus
     */
    getStatus(): MonitoringStatus {
        return { ...this.status };
    }
}
