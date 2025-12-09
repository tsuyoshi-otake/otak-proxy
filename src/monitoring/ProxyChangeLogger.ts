/**
 * ProxyChangeEvent - Represents a proxy configuration change event
 */
export interface ProxyChangeEvent {
    timestamp: number;
    previousProxy: string | null;
    newProxy: string | null;
    source: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}

/**
 * ProxyCheckEvent - Represents a proxy check execution event
 */
export interface ProxyCheckEvent {
    timestamp: number;
    success: boolean;
    proxyUrl: string | null;
    source: string | null;
    error?: string;
    trigger: 'polling' | 'focus' | 'config' | 'network';
}

/**
 * FallbackLogEvent - Represents a fallback-related event
 * Feature: auto-mode-fallback-improvements
 * Task: 6.1
 */
export interface FallbackLogEvent {
    timestamp: number;
    type: 'fallback' | 'auto-mode-off' | 'system-return';
    previousProxy: string | null;
    newProxy: string | null;
    message: string;
}

/**
 * InputSanitizer interface for dependency injection
 */
interface IInputSanitizer {
    maskPassword(url: string): string;
}

/**
 * ProxyChangeLogger - Logs proxy change and check events
 *
 * This class provides logging functionality for:
 * - Proxy change events (when proxy URL changes)
 * - Proxy check events (each detection attempt)
 * - Fallback events (Feature: auto-mode-fallback-improvements)
 *
 * All proxy URLs with credentials are automatically masked before storage.
 *
 * Requirements covered:
 * - 4.1: Log proxy changes with before/after URLs
 * - 4.2: Log proxy removal events
 * - 4.3: Log check timestamp and results
 * - 4.4: Mask credentials using InputSanitizer
 * - 7.2: Log "Fallback to Manual Proxy" (Task 6.1)
 * - 7.3: Log "Auto Mode OFF (waiting for proxy)" (Task 6.1)
 * - 7.4: Log "Switched back to System Proxy" (Task 6.1)
 */
export class ProxyChangeLogger {
    private sanitizer: IInputSanitizer;
    private changeHistory: ProxyChangeEvent[] = [];
    private checkHistory: ProxyCheckEvent[] = [];
    private fallbackHistory: FallbackLogEvent[] = [];
    private maxHistorySize: number = 100;

    constructor(sanitizer: IInputSanitizer) {
        this.sanitizer = sanitizer;
    }

    /**
     * Logs a proxy change event
     * Credentials in proxy URLs are automatically masked
     *
     * @param event - The change event to log
     */
    logChange(event: ProxyChangeEvent): void {
        const sanitizedEvent: ProxyChangeEvent = {
            ...event,
            previousProxy: this.sanitizeProxyUrl(event.previousProxy),
            newProxy: this.sanitizeProxyUrl(event.newProxy)
        };

        this.changeHistory.push(sanitizedEvent);
        this.enforceHistoryLimit(this.changeHistory);
    }

    /**
     * Logs a proxy check event
     * Credentials in proxy URLs are automatically masked
     *
     * @param event - The check event to log
     */
    logCheck(event: ProxyCheckEvent): void {
        const sanitizedEvent: ProxyCheckEvent = {
            ...event,
            proxyUrl: this.sanitizeProxyUrl(event.proxyUrl)
        };

        this.checkHistory.push(sanitizedEvent);
        this.enforceHistoryLimit(this.checkHistory);
    }

    /**
     * Gets change history, optionally limited
     *
     * @param limit - Maximum number of events to return
     * @returns Copy of change history array
     */
    getChangeHistory(limit?: number): ProxyChangeEvent[] {
        const history = [...this.changeHistory];
        if (limit !== undefined && limit > 0) {
            return history.slice(-limit);
        }
        return history;
    }

    /**
     * Gets check history, optionally limited
     *
     * @param limit - Maximum number of events to return
     * @returns Copy of check history array
     */
    getCheckHistory(limit?: number): ProxyCheckEvent[] {
        const history = [...this.checkHistory];
        if (limit !== undefined && limit > 0) {
            return history.slice(-limit);
        }
        return history;
    }

    /**
     * Clears all history
     */
    clearHistory(): void {
        this.changeHistory = [];
        this.checkHistory = [];
        this.fallbackHistory = [];
    }

    /**
     * Log fallback to manual proxy
     * Feature: auto-mode-fallback-improvements, Task 6.1
     * Requirement 7.2: Log "Fallback to Manual Proxy"
     *
     * @param previousProxy - The previous proxy URL (if any)
     * @param fallbackProxy - The fallback proxy URL being used
     */
    logFallbackToManual(previousProxy: string | null, fallbackProxy: string): void {
        const event: FallbackLogEvent = {
            timestamp: Date.now(),
            type: 'fallback',
            previousProxy: this.sanitizeProxyUrl(previousProxy),
            newProxy: this.sanitizeProxyUrl(fallbackProxy),
            message: 'Fallback to Manual Proxy'
        };
        this.fallbackHistory.push(event);
        this.enforceHistoryLimit(this.fallbackHistory);
    }

    /**
     * Log Auto Mode OFF
     * Feature: auto-mode-fallback-improvements, Task 6.1
     * Requirement 7.3: Log "Auto Mode OFF (waiting for proxy)"
     *
     * @param lastProxy - The last known proxy URL
     */
    logAutoModeOff(lastProxy: string | null): void {
        const event: FallbackLogEvent = {
            timestamp: Date.now(),
            type: 'auto-mode-off',
            previousProxy: this.sanitizeProxyUrl(lastProxy),
            newProxy: null,
            message: 'Auto Mode OFF (waiting for proxy)'
        };
        this.fallbackHistory.push(event);
        this.enforceHistoryLimit(this.fallbackHistory);
    }

    /**
     * Log return to system proxy
     * Feature: auto-mode-fallback-improvements, Task 6.1
     * Requirement 7.4: Log "Switched back to System Proxy"
     *
     * @param fallbackProxy - The fallback proxy that was being used
     * @param systemProxy - The system proxy being switched to
     */
    logSystemReturn(fallbackProxy: string | null, systemProxy: string): void {
        const event: FallbackLogEvent = {
            timestamp: Date.now(),
            type: 'system-return',
            previousProxy: this.sanitizeProxyUrl(fallbackProxy),
            newProxy: this.sanitizeProxyUrl(systemProxy),
            message: 'Switched back to System Proxy'
        };
        this.fallbackHistory.push(event);
        this.enforceHistoryLimit(this.fallbackHistory);
    }

    /**
     * Gets fallback history, optionally limited
     *
     * @param limit - Maximum number of events to return
     * @returns Copy of fallback history array
     */
    getFallbackHistory(limit?: number): FallbackLogEvent[] {
        const history = [...this.fallbackHistory];
        if (limit !== undefined && limit > 0) {
            return history.slice(-limit);
        }
        return history;
    }

    /**
     * Gets the most recent fallback event
     *
     * @returns The last fallback event, or null if no events
     */
    getLastFallbackEvent(): FallbackLogEvent | null {
        if (this.fallbackHistory.length === 0) {
            return null;
        }
        return { ...this.fallbackHistory[this.fallbackHistory.length - 1] };
    }

    /**
     * Clears fallback history
     */
    clearFallbackHistory(): void {
        this.fallbackHistory = [];
    }

    /**
     * Gets the most recent change event
     *
     * @returns The last change event, or null if no events
     */
    getLastChange(): ProxyChangeEvent | null {
        if (this.changeHistory.length === 0) {
            return null;
        }
        return { ...this.changeHistory[this.changeHistory.length - 1] };
    }

    /**
     * Gets the most recent check event
     *
     * @returns The last check event, or null if no events
     */
    getLastCheck(): ProxyCheckEvent | null {
        if (this.checkHistory.length === 0) {
            return null;
        }
        return { ...this.checkHistory[this.checkHistory.length - 1] };
    }

    /**
     * Sanitizes a proxy URL by masking credentials
     *
     * @param url - The URL to sanitize
     * @returns Sanitized URL with masked password, or null if input is null
     */
    private sanitizeProxyUrl(url: string | null): string | null {
        if (url === null) {
            return null;
        }
        return this.sanitizer.maskPassword(url);
    }

    /**
     * Enforces maximum history size by removing oldest entries
     *
     * @param history - The history array to enforce limit on
     */
    private enforceHistoryLimit<T>(history: T[]): void {
        while (history.length > this.maxHistorySize) {
            history.shift();
        }
    }
}
