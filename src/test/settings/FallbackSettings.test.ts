/**
 * @file FallbackSettings Tests
 * @description Tests for fallback settings management
 * Feature: auto-mode-fallback-improvements
 * Tasks: 7.2-7.5
 *
 * Validates:
 * - Task 7.2: Settings change listener implementation
 * - Task 7.3: Fallback disable functionality
 * - Task 7.4: Property test for fallback disable (Property 16)
 * - Task 7.5: Property test for settings immediate application (Property 17)
 * - Requirements 8.2, 8.3, 8.4
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fc from 'fast-check';
import { ProxyFallbackManager } from '../../monitoring/ProxyFallbackManager';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';
import { ProxyMode } from '../../core/types';
import { getPropertyTestRuns } from '../helpers';
import { proxyUrlArb } from '../generators';

suite('FallbackSettings Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let fallbackManager: ProxyFallbackManager;

    const createSuccessTestResult = (proxyUrl: string): TestResult => ({
        success: true,
        testUrls: ['https://www.github.com'],
        errors: [],
        proxyUrl,
        timestamp: Date.now(),
        duration: 100
    });

    const createFailureTestResult = (proxyUrl: string): TestResult => ({
        success: false,
        testUrls: ['https://www.github.com'],
        errors: [{ url: 'https://www.github.com', message: 'Connection failed' }],
        proxyUrl,
        timestamp: Date.now(),
        duration: 100
    });

    setup(() => {
        sandbox = sinon.createSandbox();

        mockConnectionTester = sandbox.createStubInstance(ProxyConnectionTester);
        mockStateManager = sandbox.createStubInstance(ProxyStateManager);
        mockUserNotifier = sandbox.createStubInstance(UserNotifier);

        fallbackManager = new ProxyFallbackManager(
            mockConnectionTester as unknown as ProxyConnectionTester,
            mockStateManager as unknown as ProxyStateManager,
            mockUserNotifier as unknown as UserNotifier,
            true // fallback enabled by default
        );
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Task 7.2: Settings change listener implementation
     * Validates: Requirements 8.4
     */
    suite('Task 7.2: Settings Change Listener', () => {
        test('should update fallback enabled state via setFallbackEnabled', () => {
            assert.strictEqual(fallbackManager.isFallbackEnabled(), true,
                'Fallback should be enabled by default');

            fallbackManager.setFallbackEnabled(false);
            assert.strictEqual(fallbackManager.isFallbackEnabled(), false,
                'Fallback should be disabled after update');

            fallbackManager.setFallbackEnabled(true);
            assert.strictEqual(fallbackManager.isFallbackEnabled(), true,
                'Fallback should be re-enabled after update');
        });

        test('should reflect setting change in next selectBestProxy call', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // With fallback enabled
            const result1 = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result1.source, 'fallback',
                'Should use fallback when enabled');

            // Disable fallback
            fallbackManager.setFallbackEnabled(false);

            // With fallback disabled
            const result2 = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result2.source, 'none',
                'Should not use fallback when disabled');
        });
    });

    /**
     * Task 7.3: Fallback disable functionality
     * Validates: Requirements 8.2, 8.3
     */
    suite('Task 7.3: Fallback Disable Functionality', () => {
        test('should not try manual proxy when fallback is disabled (Requirement 8.2)', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            fallbackManager.setFallbackEnabled(false);

            const result = await fallbackManager.selectBestProxy(null);

            // Should not try manual proxy
            sinon.assert.notCalled(mockConnectionTester.testProxyAuto);
            assert.strictEqual(result.source, 'none');
            assert.strictEqual(result.proxyUrl, null);
        });

        test('should only test system proxy when fallback is disabled (Requirement 8.3)', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            fallbackManager.setFallbackEnabled(false);

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should only test system proxy
            sinon.assert.calledOnce(mockConnectionTester.testProxyAuto);
            sinon.assert.calledWith(mockConnectionTester.testProxyAuto, systemProxyUrl);
            assert.strictEqual(result.source, 'system');
        });

        test('should return none when system proxy fails and fallback is disabled', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(systemProxyUrl));

            fallbackManager.setFallbackEnabled(false);

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should not fallback to manual proxy
            sinon.assert.calledOnce(mockConnectionTester.testProxyAuto);
            assert.strictEqual(result.source, 'none');
        });
    });

    /**
     * Task 7.4: Property test for fallback disable
     * Property 16: Fallback disable functionality
     * Validates: Requirements 8.2, 8.3
     */
    suite('Property 16: Fallback disable functionality', () => {
        test('should never use fallback when disabled', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }), // system proxy
                    fc.option(proxyUrlArb, { nil: undefined }), // manual proxy
                    fc.boolean(), // system works
                    fc.boolean(), // manual works
                    async (systemProxyUrl, manualProxyUrl, systemWorks, manualWorks) => {
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();

                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });

                        mockConnectionTester.testProxyAuto.callsFake(async (url: string) => {
                            if (url === systemProxyUrl) {
                                return systemWorks
                                    ? createSuccessTestResult(url)
                                    : createFailureTestResult(url);
                            }
                            if (url === manualProxyUrl) {
                                return manualWorks
                                    ? createSuccessTestResult(url)
                                    : createFailureTestResult(url);
                            }
                            return createFailureTestResult(url);
                        });

                        // Disable fallback
                        fallbackManager.setFallbackEnabled(false);

                        const result = await fallbackManager.selectBestProxy(systemProxyUrl);

                        // Should never return 'fallback' source when disabled
                        assert.notStrictEqual(result.source, 'fallback',
                            'Should never use fallback when disabled');

                        // Should only use system or none
                        assert.ok(
                            result.source === 'system' || result.source === 'none',
                            `Source should be system or none, got: ${result.source}`
                        );

                        // Re-enable for next iteration
                        fallbackManager.setFallbackEnabled(true);
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 7.5: Property test for settings immediate application
     * Property 17: Settings immediate application
     * Validates: Requirements 8.4
     */
    suite('Property 17: Settings immediate application', () => {
        test('should apply setting changes immediately', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate sequence of enable/disable toggles
                    fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
                    proxyUrlArb,
                    async (toggleSequence, manualProxyUrl) => {
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();

                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });
                        mockConnectionTester.testProxyAuto.resolves(
                            createSuccessTestResult(manualProxyUrl)
                        );

                        for (const enabled of toggleSequence) {
                            fallbackManager.setFallbackEnabled(enabled);

                            // Setting should be reflected immediately
                            assert.strictEqual(
                                fallbackManager.isFallbackEnabled(),
                                enabled,
                                'Setting should be reflected immediately'
                            );

                            // Behavior should match setting
                            mockConnectionTester.testProxyAuto.resetHistory();
                            const result = await fallbackManager.selectBestProxy(null);

                            if (enabled) {
                                // Should try fallback
                                assert.strictEqual(result.source, 'fallback',
                                    'Should use fallback when enabled');
                            } else {
                                // Should not try fallback
                                assert.strictEqual(result.source, 'none',
                                    'Should not use fallback when disabled');
                            }
                        }

                        // Reset to enabled for next test
                        fallbackManager.setFallbackEnabled(true);
                    }
                ),
                { numRuns }
            );
        });
    });
});
