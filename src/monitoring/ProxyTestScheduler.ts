/**
 * @file ProxyTestScheduler
 * @description Schedules periodic proxy connection tests
 * Feature: auto-mode-proxy-testing
 *
 * This class manages periodic execution of proxy connection tests,
 * allowing for configurable test intervals and immediate test triggers.
 */

import { ProxyConnectionTester } from './ProxyConnectionTester';
import { TestResult } from '../utils/ProxyUtils';
import { Logger } from '../utils/Logger';

/**
 * Minimum allowed test interval in milliseconds (30 seconds)
 */
const MIN_INTERVAL_MS = 30000;

/**
 * Maximum allowed test interval in milliseconds (10 minutes)
 */
const MAX_INTERVAL_MS = 600000;

/**
 * ProxyTestScheduler manages periodic proxy connection testing
 *
 * Features:
 * - Configurable test intervals (30 seconds to 10 minutes)
 * - Automatic interval restart on configuration change
 * - Immediate test trigger capability
 * - Test result callback support
 */
export class ProxyTestScheduler {
    private tester: ProxyConnectionTester;
    private interval?: ReturnType<typeof setInterval>;
    private testIntervalMs: number;
    private active: boolean;
    private currentProxyUrl?: string;
    private onTestComplete?: (result: TestResult) => void;

    /**
     * Create a new ProxyTestScheduler
     *
     * @param tester - The ProxyConnectionTester instance to use for testing
     * @param testIntervalMs - Initial test interval in milliseconds
     */
    constructor(tester: ProxyConnectionTester, testIntervalMs: number) {
        this.tester = tester;
        this.testIntervalMs = this.clampInterval(testIntervalMs);
        this.active = false;
    }

    /**
     * Start the scheduler
     *
     * @param proxyUrl - The proxy URL to test
     * @param onTestComplete - Callback function called when each test completes
     */
    start(proxyUrl: string, onTestComplete: (result: TestResult) => void): void {
        this.stop(); // Clear any existing interval

        this.currentProxyUrl = proxyUrl;
        this.onTestComplete = onTestComplete;
        this.active = true;

        Logger.log(`ProxyTestScheduler started: interval=${this.testIntervalMs}ms`);

        // Start the interval timer
        this.interval = setInterval(async () => {
            await this.executeTest();
        }, this.testIntervalMs);
    }

    /**
     * Stop the scheduler
     */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }

        this.active = false;
        this.currentProxyUrl = undefined;
        this.onTestComplete = undefined;

        Logger.log('ProxyTestScheduler stopped');
    }

    /**
     * Update the test interval
     * If scheduler is active, restarts with new interval
     *
     * @param intervalMs - New interval in milliseconds
     */
    updateInterval(intervalMs: number): void {
        const newInterval = this.clampInterval(intervalMs);

        if (newInterval !== this.testIntervalMs) {
            Logger.log(`ProxyTestScheduler interval updated: ${this.testIntervalMs}ms -> ${newInterval}ms`);
            this.testIntervalMs = newInterval;

            // If active, restart with new interval
            if (this.active && this.currentProxyUrl && this.onTestComplete) {
                const proxyUrl = this.currentProxyUrl;
                const callback = this.onTestComplete;
                this.start(proxyUrl, callback);
            }
        }
    }

    /**
     * Update the proxy URL to test
     *
     * @param proxyUrl - New proxy URL
     */
    updateProxyUrl(proxyUrl: string): void {
        this.currentProxyUrl = proxyUrl;
        Logger.log(`ProxyTestScheduler proxy URL updated: ${proxyUrl}`);
    }

    /**
     * Trigger an immediate test
     * Does nothing if scheduler is not active
     */
    async triggerImmediateTest(): Promise<void> {
        if (!this.active || !this.currentProxyUrl) {
            return;
        }

        Logger.log('ProxyTestScheduler: triggering immediate test');
        await this.executeTest();
    }

    /**
     * Check if scheduler is active
     *
     * @returns true if scheduler is running
     */
    isActive(): boolean {
        return this.active;
    }

    /**
     * Get current test interval in milliseconds
     *
     * @returns Current interval in milliseconds
     */
    getIntervalMs(): number {
        return this.testIntervalMs;
    }

    /**
     * Get current proxy URL being tested
     *
     * @returns Current proxy URL or undefined if not set
     */
    getCurrentProxyUrl(): string | undefined {
        return this.currentProxyUrl;
    }

    /**
     * Execute a single test
     */
    private async executeTest(): Promise<void> {
        if (!this.currentProxyUrl || !this.onTestComplete) {
            return;
        }

        try {
            const result = await this.tester.testProxyAuto(this.currentProxyUrl);
            this.onTestComplete(result);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('ProxyTestScheduler test error:', errorMsg);
        }
    }

    /**
     * Clamp interval to valid range
     *
     * @param intervalMs - Input interval in milliseconds
     * @returns Clamped interval within MIN_INTERVAL_MS and MAX_INTERVAL_MS
     */
    private clampInterval(intervalMs: number): number {
        return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, intervalMs));
    }
}

/**
 * Get minimum allowed test interval in milliseconds
 */
export function getMinInterval(): number {
    return MIN_INTERVAL_MS;
}

/**
 * Get maximum allowed test interval in milliseconds
 */
export function getMaxInterval(): number {
    return MAX_INTERVAL_MS;
}
