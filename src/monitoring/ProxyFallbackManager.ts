/**
 * @file ProxyFallbackManager
 * @description Manages fallback logic for Auto mode proxy selection
 * Feature: auto-mode-fallback-improvements
 * Task: 1.1
 *
 * This class handles the fallback logic when system proxy is not available,
 * attempting to use manual proxy as a fallback option.
 *
 * Priority order:
 * 1. System proxy (if available and reachable)
 * 2. Manual proxy (fallback, if available and reachable)
 * 3. Direct connection (no proxy)
 */

import { ProxyConnectionTester } from './ProxyConnectionTester';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { UserNotifier } from '../errors/UserNotifier';
import { TestResult } from '../utils/ProxyUtils';
import { Logger } from '../utils/Logger';
import { I18nManager } from '../i18n/I18nManager';

/**
 * Result of proxy selection
 * Indicates which proxy was selected and whether it was successful
 */
export interface ProxySelectionResult {
    /** Selected proxy URL, or null if no proxy available */
    proxyUrl: string | null;
    /** Source of the selected proxy */
    source: 'system' | 'fallback' | 'none';
    /** Connection test result */
    testResult?: TestResult;
    /** Whether a working proxy was found */
    success: boolean;
}

/**
 * ProxyFallbackManager handles fallback proxy selection logic
 *
 * Requirements covered:
 * - 1.1: Check manual proxy when system proxy not detected
 * - 1.2: Test connection when manual proxy exists
 * - 1.3: Enable proxy when manual proxy test succeeds
 * - 1.4: Disable proxy when manual proxy test fails
 * - 1.5: Use direct connection when no manual proxy exists
 * - 5.1-5.4: Priority-based proxy selection
 * - 8.2-8.3: Fallback enable/disable functionality
 */
export class ProxyFallbackManager {
    private connectionTester: ProxyConnectionTester;
    private stateManager: ProxyStateManager;
    private userNotifier: UserNotifier;
    private fallbackEnabled: boolean;

    /**
     * Create a new ProxyFallbackManager
     *
     * @param connectionTester - Instance to test proxy connections
     * @param stateManager - Instance to get/set proxy state
     * @param userNotifier - Instance to show user notifications
     * @param fallbackEnabled - Whether fallback is enabled (default: true)
     */
    constructor(
        connectionTester: ProxyConnectionTester,
        stateManager: ProxyStateManager,
        userNotifier: UserNotifier,
        fallbackEnabled: boolean = true
    ) {
        this.connectionTester = connectionTester;
        this.stateManager = stateManager;
        this.userNotifier = userNotifier;
        this.fallbackEnabled = fallbackEnabled;
    }

    /**
     * Select the best available proxy
     *
     * Priority order:
     * 1. System proxy (if provided and reachable)
     * 2. Manual proxy (fallback, if enabled and reachable)
     * 3. No proxy (direct connection)
     *
     * @param systemProxyUrl - Detected system proxy URL, or null if not detected
     * @returns ProxySelectionResult indicating the selected proxy
     */
    async selectBestProxy(systemProxyUrl: string | null): Promise<ProxySelectionResult> {
        // Step 1: Try system proxy if available
        if (systemProxyUrl) {
            const systemResult = await this.testSystemProxy(systemProxyUrl);
            if (systemResult.success) {
                return {
                    proxyUrl: systemProxyUrl,
                    source: 'system',
                    testResult: systemResult,
                    success: true
                };
            }

            Logger.log(`System proxy ${systemProxyUrl} is not reachable, trying fallback`);
        }

        // Step 2: Try manual proxy as fallback (if enabled)
        if (this.fallbackEnabled) {
            const manualResult = await this.testManualProxy();
            if (manualResult) {
                if (manualResult.success) {
                    this.notifyFallbackUsage(manualResult.proxyUrl!);
                    return {
                        proxyUrl: manualResult.proxyUrl!,
                        source: 'fallback',
                        testResult: manualResult,
                        success: true
                    };
                } else {
                    this.notifyFallbackFailed();
                }
            }
        }

        // Step 3: No proxy available - use direct connection
        return {
            proxyUrl: null,
            source: 'none',
            success: false
        };
    }

    /**
     * Enable or disable fallback functionality
     *
     * @param enabled - Whether fallback should be enabled
     */
    setFallbackEnabled(enabled: boolean): void {
        this.fallbackEnabled = enabled;
        Logger.log(`Fallback ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Check if fallback is enabled
     *
     * @returns true if fallback is enabled
     */
    isFallbackEnabled(): boolean {
        return this.fallbackEnabled;
    }

    /**
     * Test system proxy connection
     *
     * @param proxyUrl - System proxy URL to test
     * @returns Test result
     */
    private async testSystemProxy(proxyUrl: string): Promise<TestResult> {
        try {
            return await this.connectionTester.testProxyAuto(proxyUrl);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('System proxy test error:', errorMsg);
            return {
                success: false,
                testUrls: [],
                errors: [{ url: proxyUrl, message: errorMsg }],
                proxyUrl,
                timestamp: Date.now()
            };
        }
    }

    /**
     * Test manual proxy connection (if configured)
     *
     * @returns Test result, or null if no manual proxy configured
     */
    private async testManualProxy(): Promise<TestResult | null> {
        try {
            const state = await this.stateManager.getState();
            const manualProxyUrl = state.manualProxyUrl;

            if (!manualProxyUrl) {
                Logger.log('No manual proxy configured for fallback');
                return null;
            }

            Logger.log(`Testing manual proxy for fallback: ${manualProxyUrl}`);
            return await this.connectionTester.testProxyAuto(manualProxyUrl);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('Manual proxy test error:', errorMsg);
            return null;
        }
    }

    /**
     * Notify user that fallback proxy is being used
     *
     * @param proxyUrl - The fallback proxy URL
     */
    private notifyFallbackUsage(proxyUrl: string): void {
        try {
            const i18n = I18nManager.getInstance();
            this.userNotifier.showSuccess(
                i18n.t('fallback.usingManualProxy', { url: proxyUrl })
            );
            Logger.log(`Fallback to Manual Proxy: ${proxyUrl}`);
        } catch (error) {
            // In test environment, I18nManager may not be properly initialized
            this.userNotifier.showSuccess(`Using manual proxy as fallback: ${proxyUrl}`);
            Logger.log(`Fallback to Manual Proxy: ${proxyUrl}`);
        }
    }

    /**
     * Notify user that fallback proxy test failed
     */
    private notifyFallbackFailed(): void {
        try {
            const i18n = I18nManager.getInstance();
            this.userNotifier.showWarning(
                i18n.t('fallback.manualProxyFailed')
            );
            Logger.log('Manual proxy fallback failed');
        } catch (error) {
            // In test environment, I18nManager may not be properly initialized
            this.userNotifier.showWarning('Manual proxy is also unavailable');
            Logger.log('Manual proxy fallback failed');
        }
    }
}
