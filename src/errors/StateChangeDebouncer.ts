/**
 * @file StateChangeDebouncer
 * @description Debounces consecutive state changes to notify only the final state
 * Feature: auto-mode-proxy-testing
 * Property 8: 連続状態変化時の最終状態通知
 *
 * When multiple state changes occur in quick succession, only the last state
 * should be notified. This prevents notification spam when proxy status fluctuates.
 */

/**
 * Represents a proxy state change event
 */
export interface StateChangeEvent {
    proxyUrl: string;
    reachable: boolean;
    timestamp: number;
}

/**
 * Callback function for state change notifications
 */
export type StateChangeCallback = (event: StateChangeEvent) => void;

/**
 * Default debounce delay in milliseconds
 */
const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * StateChangeDebouncer manages debouncing of proxy state changes
 *
 * Features:
 * - Debounces state changes with configurable delay (default 1 second)
 * - Only notifies the final state when multiple changes occur
 * - Supports multiple proxy URLs independently
 * - Can be disposed to clean up timers
 */
export class StateChangeDebouncer {
    private debounceMs: number;
    private pendingChanges: Map<string, NodeJS.Timeout>;
    private pendingStates: Map<string, StateChangeEvent>;
    private callback?: StateChangeCallback;

    /**
     * Create a new StateChangeDebouncer
     *
     * @param debounceMs - Debounce delay in milliseconds (default 1000ms)
     */
    constructor(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
        this.debounceMs = debounceMs;
        this.pendingChanges = new Map();
        this.pendingStates = new Map();
    }

    /**
     * Set the callback to be invoked when a debounced state change is ready
     *
     * @param callback - Function to call with the final state
     */
    setCallback(callback: StateChangeCallback): void {
        this.callback = callback;
    }

    /**
     * Queue a state change event
     * If another change for the same proxy URL is pending, it will be replaced
     *
     * @param event - The state change event
     */
    queueStateChange(event: StateChangeEvent): void {
        const key = event.proxyUrl;

        // Clear existing timer for this proxy URL
        const existingTimer = this.pendingChanges.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Store the pending state
        this.pendingStates.set(key, event);

        // Set new timer
        const timer = setTimeout(() => {
            this.notifyStateChange(key);
        }, this.debounceMs);

        this.pendingChanges.set(key, timer);
    }

    /**
     * Get the pending state for a proxy URL (for testing purposes)
     *
     * @param proxyUrl - The proxy URL to check
     * @returns The pending state or undefined
     */
    getPendingState(proxyUrl: string): StateChangeEvent | undefined {
        return this.pendingStates.get(proxyUrl);
    }

    /**
     * Check if there's a pending change for a proxy URL
     *
     * @param proxyUrl - The proxy URL to check
     * @returns true if a change is pending
     */
    hasPendingChange(proxyUrl: string): boolean {
        return this.pendingChanges.has(proxyUrl);
    }

    /**
     * Cancel a pending change for a specific proxy URL
     *
     * @param proxyUrl - The proxy URL to cancel
     */
    cancelPendingChange(proxyUrl: string): void {
        const timer = this.pendingChanges.get(proxyUrl);
        if (timer) {
            clearTimeout(timer);
            this.pendingChanges.delete(proxyUrl);
            this.pendingStates.delete(proxyUrl);
        }
    }

    /**
     * Clear all pending changes
     */
    clear(): void {
        for (const timer of this.pendingChanges.values()) {
            clearTimeout(timer);
        }
        this.pendingChanges.clear();
        this.pendingStates.clear();
    }

    /**
     * Dispose the debouncer and clean up all timers
     */
    dispose(): void {
        this.clear();
        this.callback = undefined;
    }

    /**
     * Notify the callback with the final state
     */
    private notifyStateChange(proxyUrl: string): void {
        const event = this.pendingStates.get(proxyUrl);
        if (event && this.callback) {
            this.callback(event);
        }

        // Clean up
        this.pendingChanges.delete(proxyUrl);
        this.pendingStates.delete(proxyUrl);
    }
}

/**
 * Get the default debounce delay in milliseconds
 */
export function getDefaultDebounceMs(): number {
    return DEFAULT_DEBOUNCE_MS;
}
