/**
 * @file ProxyFallbackManager Property-Based Tests
 * @description Property-based tests for ProxyFallbackManager
 * Feature: auto-mode-fallback-improvements
 * Tasks: 1.3, 1.4, 1.6, 1.7
 *
 * Validates:
 * - Property 1: Fallback proxy verification and selection (Task 1.3)
 * - Property 2: Priority-based proxy selection (Task 1.4)
 * - Property 3: Fallback usage notification (Task 1.6)
 * - Property 6: Fallback failure notification (Task 1.7)
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

suite('ProxyFallbackManager Property Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;

    const createTestResult = (proxyUrl: string, success: boolean): TestResult => ({
        success,
        testUrls: ['https://www.github.com'],
        errors: success ? [] : [{ url: 'https://www.github.com', message: 'Connection failed' }],
        proxyUrl,
        timestamp: Date.now(),
        duration: 100
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        mockConnectionTester = sandbox.createStubInstance(ProxyConnectionTester);
        mockStateManager = sandbox.createStubInstance(ProxyStateManager);
        mockUserNotifier = sandbox.createStubInstance(UserNotifier);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Feature: auto-mode-fallback-improvements
     * Property 1: Fallback proxy verification and selection
     * Task: 1.3
     * Validates: Requirements 1.1, 1.2, 1.5
     *
     * For any Auto mode state, when system proxy is not detected,
     * the system should check for manual proxy URL existence, test connection if exists,
     * and use direct connection if not exists.
     */
    suite('Property 1: Fallback proxy verification and selection', () => {
        test('should check manual proxy when system proxy is null and fallback is enabled', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate optional manual proxy URL
                    fc.option(proxyUrlArb, { nil: undefined }),
                    async (manualProxyUrl) => {
                        // Reset mocks for each iteration
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();
                        mockUserNotifier.showSuccess.reset();
                        mockUserNotifier.showWarning.reset();

                        // Setup state manager mock
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });

                        // Setup connection tester mock
                        if (manualProxyUrl) {
                            mockConnectionTester.testProxyAuto.resolves(createTestResult(manualProxyUrl, true));
                        }

                        const fallbackManager = new ProxyFallbackManager(
                            mockConnectionTester as unknown as ProxyConnectionTester,
                            mockStateManager as unknown as ProxyStateManager,
                            mockUserNotifier as unknown as UserNotifier,
                            true
                        );

                        const result = await fallbackManager.selectBestProxy(null);

                        if (manualProxyUrl) {
                            // When manual proxy exists, it should be tested
                            assert.strictEqual(mockConnectionTester.testProxyAuto.calledWith(manualProxyUrl), true,
                                'Should test manual proxy when it exists');
                            assert.strictEqual(result.source, 'fallback',
                                'Should use fallback source when manual proxy works');
                            assert.strictEqual(result.proxyUrl, manualProxyUrl,
                                'Should return manual proxy URL');
                        } else {
                            // When no manual proxy, should return none
                            assert.strictEqual(result.source, 'none',
                                'Should return none when no manual proxy configured');
                            assert.strictEqual(result.proxyUrl, null,
                                'Should return null proxy URL');
                        }
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Feature: auto-mode-fallback-improvements
     * Property 2: Priority-based proxy selection
     * Task: 1.4
     * Validates: Requirements 5.1, 5.2, 5.3, 5.4
     *
     * For any proxy selection situation, the system should use the following priority:
     * 1) System proxy (if available)
     * 2) Manual proxy (fallback, if available)
     * 3) Direct connection
     */
    suite('Property 2: Priority-based proxy selection', () => {
        test('should follow priority order: system > manual > none', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate system proxy URL (can be null or valid URL)
                    fc.option(proxyUrlArb, { nil: null }),
                    // Generate manual proxy URL (can be undefined or valid URL)
                    fc.option(proxyUrlArb, { nil: undefined }),
                    // Generate whether proxies are reachable
                    fc.boolean(),
                    fc.boolean(),
                    async (systemProxyUrl, manualProxyUrl, systemReachable, manualReachable) => {
                        // Reset mocks for each iteration
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();
                        mockUserNotifier.showSuccess.reset();
                        mockUserNotifier.showWarning.reset();

                        // Setup state manager mock
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });

                        // Setup connection tester mock
                        let callIndex = 0;
                        mockConnectionTester.testProxyAuto.callsFake(async (url: string) => {
                            if (url === systemProxyUrl) {
                                return createTestResult(url, systemReachable);
                            } else if (url === manualProxyUrl) {
                                return createTestResult(url, manualReachable);
                            }
                            return createTestResult(url, false);
                        });

                        const fallbackManager = new ProxyFallbackManager(
                            mockConnectionTester as unknown as ProxyConnectionTester,
                            mockStateManager as unknown as ProxyStateManager,
                            mockUserNotifier as unknown as UserNotifier,
                            true
                        );

                        const result = await fallbackManager.selectBestProxy(systemProxyUrl);

                        // Verify priority order
                        if (systemProxyUrl && systemReachable) {
                            // System proxy takes highest priority
                            assert.strictEqual(result.source, 'system',
                                'Should use system proxy when available and reachable');
                            assert.strictEqual(result.proxyUrl, systemProxyUrl);
                        } else if (manualProxyUrl && manualReachable) {
                            // Manual proxy is fallback
                            assert.strictEqual(result.source, 'fallback',
                                'Should fallback to manual proxy when system unavailable');
                            assert.strictEqual(result.proxyUrl, manualProxyUrl);
                        } else {
                            // No proxy available
                            assert.strictEqual(result.source, 'none',
                                'Should return none when all proxies unavailable');
                            assert.strictEqual(result.proxyUrl, null);
                        }
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Feature: auto-mode-fallback-improvements
     * Property 3: Fallback usage notification
     * Task: 1.6
     * Validates: Requirements 2.1
     *
     * For any situation where fallback proxy is used,
     * a notification should be displayed indicating fallback usage.
     */
    suite('Property 3: Fallback usage notification', () => {
        test('should notify when fallback proxy is successfully used', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    proxyUrlArb,
                    async (manualProxyUrl) => {
                        // Reset mocks for each iteration
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();
                        mockUserNotifier.showSuccess.reset();
                        mockUserNotifier.showWarning.reset();

                        // Setup: Manual proxy exists and is reachable
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });
                        mockConnectionTester.testProxyAuto.resolves(createTestResult(manualProxyUrl, true));

                        const fallbackManager = new ProxyFallbackManager(
                            mockConnectionTester as unknown as ProxyConnectionTester,
                            mockStateManager as unknown as ProxyStateManager,
                            mockUserNotifier as unknown as UserNotifier,
                            true
                        );

                        // System proxy is null, so fallback will be used
                        const result = await fallbackManager.selectBestProxy(null);

                        // Verify notification was shown
                        assert.strictEqual(result.source, 'fallback',
                            'Should use fallback proxy');
                        assert.strictEqual(mockUserNotifier.showSuccess.called, true,
                            'Should notify user when fallback proxy is used');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Feature: auto-mode-fallback-improvements
     * Property 6: Fallback failure notification
     * Task: 1.7
     * Validates: Requirements 2.4
     *
     * For any fallback proxy test failure,
     * a notification should be displayed indicating fallback failure.
     */
    suite('Property 6: Fallback failure notification', () => {
        test('should notify when fallback proxy test fails', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    proxyUrlArb,
                    async (manualProxyUrl) => {
                        // Reset mocks for each iteration
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();
                        mockUserNotifier.showSuccess.reset();
                        mockUserNotifier.showWarning.reset();

                        // Setup: Manual proxy exists but is NOT reachable
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });
                        mockConnectionTester.testProxyAuto.resolves(createTestResult(manualProxyUrl, false));

                        const fallbackManager = new ProxyFallbackManager(
                            mockConnectionTester as unknown as ProxyConnectionTester,
                            mockStateManager as unknown as ProxyStateManager,
                            mockUserNotifier as unknown as UserNotifier,
                            true
                        );

                        // System proxy is null, so fallback will be attempted and fail
                        const result = await fallbackManager.selectBestProxy(null);

                        // Verify notification was shown
                        assert.strictEqual(result.source, 'none',
                            'Should return none when fallback fails');
                        assert.strictEqual(mockUserNotifier.showWarning.called, true,
                            'Should notify user when fallback proxy fails');
                    }
                ),
                { numRuns }
            );
        });
    });
});
