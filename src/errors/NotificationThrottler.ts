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
     * Upper bound on the number of distinct notification keys retained.
     *
     * Throttle keys embed the raw (sanitized) error message, so over a long
     * session the key space grows with the number of distinct messages seen.
     * Without a bound, `lastNotifications` would grow with session length
     * (O(session)). Capping it makes memory scale with the cap (a constant),
     * not with how long the editor stays open. Eviction is amortized O(1).
     */
    private static readonly MAX_ENTRIES = 200;

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
        // Re-insert so the key moves to the most-recent position. A Map preserves
        // insertion order and `set` on an existing key keeps its original slot, so
        // deleting first turns iteration order into recency order (true LRU).
        this.lastNotifications.delete(messageKey);
        this.lastNotifications.set(messageKey, Date.now());
        this.evictIfNeeded();
    }

    /**
     * Keeps `lastNotifications` bounded by evicting the least-recently recorded
     * keys once the cap is exceeded. The oldest key is the first in iteration
     * order; evicting it is O(1), making this amortized O(1) per record.
     *
     * Evicting an entry that is still inside its throttle window can at worst
     * allow one extra notification for that key — an acceptable, bounded
     * relaxation that only occurs under more than MAX_ENTRIES distinct keys.
     */
    private evictIfNeeded(): void {
        while (this.lastNotifications.size > NotificationThrottler.MAX_ENTRIES) {
            const oldestKey = this.lastNotifications.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.lastNotifications.delete(oldestKey);
        }
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
