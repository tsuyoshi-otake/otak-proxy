/**
 * NotificationThrottler manages notification frequency to prevent duplicate notifications
 * from overwhelming the user. It tracks notification history and applies throttling rules
 * based on message keys and timing.
 */
export class NotificationThrottler {
    private lastNotifications: Map<string, number> = new Map();
    private consecutiveFailures: Map<string, number> = new Map();
    private readonly defaultThrottleMs = 5000;

    /**
     * Checks if a notification should be shown based on throttling rules
     * @param messageKey - Unique key identifying the notification type
     * @param throttleMs - Optional custom throttle time in milliseconds (default: 5000ms)
     * @returns true if the notification should be shown, false if it should be suppressed
     */
    shouldShow(messageKey: string, throttleMs?: number): boolean {
        const now = Date.now();
        const lastShown = this.lastNotifications.get(messageKey);
        const throttleTime = throttleMs ?? this.defaultThrottleMs;

        if (lastShown === undefined) {
            return true;
        }

        const timeSinceLastShown = now - lastShown;
        return timeSinceLastShown >= throttleTime;
    }

    /**
     * Records that a notification was shown
     * @param messageKey - Unique key identifying the notification type
     */
    recordNotification(messageKey: string): void {
        this.lastNotifications.set(messageKey, Date.now());
    }

    /**
     * Checks if a failure notification should be shown based on consecutive failure count
     * Shows notification on first failure and every 5th failure
     * @param failureKey - Unique key identifying the failure type
     * @returns true if the notification should be shown
     */
    shouldShowFailure(failureKey: string): boolean {
        const currentCount = this.consecutiveFailures.get(failureKey) ?? 0;
        const newCount = currentCount + 1;
        this.consecutiveFailures.set(failureKey, newCount);

        // Show on first failure (count = 1) and every 5th failure (5, 10, 15, etc.)
        return newCount === 1 || newCount % 5 === 0;
    }

    /**
     * Resets the consecutive failure count for a specific failure type
     * @param failureKey - Unique key identifying the failure type
     */
    resetFailureCount(failureKey: string): void {
        this.consecutiveFailures.delete(failureKey);
    }

    /**
     * Clears all throttling state
     */
    clear(): void {
        this.lastNotifications.clear();
        this.consecutiveFailures.clear();
    }

    /**
     * Clears old notification records to prevent memory leaks
     * Removes records older than the specified age
     * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
     */
    clearOldRecords(maxAgeMs: number = 3600000): void {
        const now = Date.now();
        const keysToDelete: string[] = [];

        for (const [key, timestamp] of this.lastNotifications.entries()) {
            if (now - timestamp > maxAgeMs) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.lastNotifications.delete(key);
        }
    }
}
