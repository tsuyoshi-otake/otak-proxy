/**
 * @file ProxyConnectionTester
 * @description Manages proxy connection testing with support for auto and manual modes
 * Feature: auto-mode-proxy-testing
 *
 * This class handles proxy connection testing with different configurations
 * for automatic (background) testing and manual (user-initiated) testing.
 */

import { UserNotifier } from '../errors/UserNotifier';
import { Logger } from '../utils/Logger';
import {
    TestResult,
    testProxyConnectionParallel,
    getDefaultTestUrls,
    getDefaultAutoTimeout,
    getDefaultManualTimeout,
    sanitizeProxyUrl
} from '../utils/ProxyUtils';

/**
 * ProxyConnectionTester manages proxy connection testing
 *
 * Features:
 * - Auto mode: 3 second timeout, parallel execution, brief notifications
 * - Manual mode: 5 second timeout, detailed results
 * - Result caching for each proxy URL
 * - Test-in-progress tracking
 */
export class ProxyConnectionTester {
    private userNotifier: UserNotifier;
    private lastTestResult: Map<string, TestResult>;
    private testInProgress: boolean;

    constructor(userNotifier: UserNotifier) {
        this.userNotifier = userNotifier;
        this.lastTestResult = new Map();
        this.testInProgress = false;
    }

    /**
     * Execute automatic proxy test (3 second timeout, parallel execution)
     * Used for background/periodic testing
     *
     * @param proxyUrl - The proxy URL to test
     * @returns Test result
     */
    async testProxyAuto(proxyUrl: string): Promise<TestResult> {
        this.testInProgress = true;

        try {
            const result = await testProxyConnectionParallel(
                proxyUrl,
                getDefaultTestUrls(),
                getDefaultAutoTimeout()
            );

            // Cache the result
            this.lastTestResult.set(proxyUrl, result);

            // Notify with brief message for auto tests
            this.notifyTestResult(proxyUrl, result, true);

            return result;
        } finally {
            this.testInProgress = false;
        }
    }

    /**
     * Execute manual proxy test (5 second timeout, detailed results)
     * Used for user-initiated testing
     *
     * @param proxyUrl - The proxy URL to test
     * @returns Test result
     */
    async testProxyManual(proxyUrl: string): Promise<TestResult> {
        this.testInProgress = true;

        try {
            const result = await testProxyConnectionParallel(
                proxyUrl,
                getDefaultTestUrls(),
                getDefaultManualTimeout()
            );

            // Cache the result
            this.lastTestResult.set(proxyUrl, result);

            // Notify with detailed message for manual tests
            this.notifyTestResult(proxyUrl, result, false);

            return result;
        } finally {
            this.testInProgress = false;
        }
    }

    /**
     * Get the last test result for a specific proxy URL
     *
     * @param proxyUrl - The proxy URL to look up
     * @returns The last test result, or undefined if not tested
     */
    getLastTestResult(proxyUrl: string): TestResult | undefined {
        return this.lastTestResult.get(proxyUrl);
    }

    /**
     * Check if a test is currently in progress
     *
     * @returns true if a test is running
     */
    isTestInProgress(): boolean {
        return this.testInProgress;
    }

    /**
     * Clear cached test results
     */
    clearCache(): void {
        this.lastTestResult.clear();
    }

    /**
     * Notify user of test result
     *
     * @param proxyUrl - The tested proxy URL
     * @param result - The test result
     * @param isAuto - Whether this is an automatic test
     */
    private notifyTestResult(proxyUrl: string, result: TestResult, isAuto: boolean): void {
        const sanitizedUrl = sanitizeProxyUrl(proxyUrl);

        if (isAuto) {
            // Brief notification for auto tests
            if (result.success) {
                Logger.log(`Auto test passed: ${sanitizedUrl}`);
                // Don't show notification for successful auto tests to avoid spam
            } else {
                Logger.warn(`Auto test failed: ${sanitizedUrl}`);
                // Only log, don't show notification for failed auto tests
                // The ProxyMonitor will handle state changes and notifications
            }
        } else {
            // Detailed notification for manual tests
            if (result.success) {
                this.userNotifier.showSuccess(
                    `Proxy connection successful: ${sanitizedUrl} (${result.duration}ms)`
                );
            } else {
                const errorSummary = result.errors.length > 0
                    ? result.errors[0].message
                    : 'Connection failed';
                this.userNotifier.showWarning(
                    `Proxy connection failed: ${sanitizedUrl} - ${errorSummary}`
                );
            }
        }
    }
}
