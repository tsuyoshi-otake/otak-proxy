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
 *
 * All proxy URLs with credentials are automatically masked before storage.
 *
 * Requirements covered:
 * - 4.1: Log proxy changes with before/after URLs
 * - 4.2: Log proxy removal events
 * - 4.3: Log check timestamp and results
 * - 4.4: Mask credentials using InputSanitizer
 */
export class ProxyChangeLogger {
    private sanitizer: IInputSanitizer;
    private changeHistory: ProxyChangeEvent[] = [];
    private checkHistory: ProxyCheckEvent[] = [];
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
