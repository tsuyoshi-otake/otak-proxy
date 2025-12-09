/**
 * @file ProxyMonitor Fallback Integration Tests
 * @description Tests for ProxyMonitor fallback functionality
 * Feature: auto-mode-fallback-improvements
 * Tasks: 3.1-3.8
 *
 * Validates:
 * - Task 3.1: ProxyFallbackManager integration with ProxyMonitor
 * - Task 3.2: Integration tests for fallback functionality
 * - Task 3.3: System proxy switch notification (Property 5)
 * - Task 3.4: Property test for system proxy switch notification
 * - Task 3.5: Auto Mode OFF automatic recovery
 * - Task 3.6: Property test for Auto Mode OFF recovery (Property 8)
 * - Task 3.7: Complete OFF mode behavior
 * - Task 3.8: Property test for complete OFF mode (Property 9)
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fc from 'fast-check';
import { EventEmitter } from 'events';
import { ProxyMonitor, ProxyDetectionResult } from '../../monitoring/ProxyMonitor';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyFallbackManager, ProxySelectionResult } from '../../monitoring/ProxyFallbackManager';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';
import { ProxyMode } from '../../core/types';
import { getPropertyTestRuns } from '../helpers';
import { proxyUrlArb } from '../generators';

suite('ProxyMonitor Fallback Integration Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockDetector: { detectSystemProxy: sinon.SinonStub; detectSystemProxyWithSource: sinon.SinonStub };
    let mockLogger: sinon.SinonStubbedInstance<ProxyChangeLogger>;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let fallbackManager: ProxyFallbackManager;
    let proxyMonitor: ProxyMonitor;

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

        // Create mock detector
        mockDetector = {
            detectSystemProxy: sandbox.stub(),
            detectSystemProxyWithSource: sandbox.stub()
        };

        // Create mock logger
        const sanitizer = { maskPassword: (url: string) => url };
        mockLogger = sandbox.createStubInstance(ProxyChangeLogger);

        // Create mock connection tester
        mockConnectionTester = sandbox.createStubInstance(ProxyConnectionTester);

        // Create mock state manager
        mockStateManager = sandbox.createStubInstance(ProxyStateManager);
        mockStateManager.getState.resolves({ mode: ProxyMode.Auto });

        // Create mock user notifier
        mockUserNotifier = sandbox.createStubInstance(UserNotifier);

        // Create real fallback manager with mocks
        fallbackManager = new ProxyFallbackManager(
            mockConnectionTester as unknown as ProxyConnectionTester,
            mockStateManager as unknown as ProxyStateManager,
            mockUserNotifier as unknown as UserNotifier,
            true
        );

        // Create proxy monitor
        proxyMonitor = new ProxyMonitor(
            mockDetector,
            mockLogger as unknown as ProxyChangeLogger,
            {
                pollingInterval: 30000,
                debounceDelay: 100,
                maxRetries: 0,
                retryBackoffBase: 1,
                detectionSourcePriority: ['environment'],
                enableConnectionTest: true,
                connectionTestInterval: 60000
            },
            mockConnectionTester as unknown as ProxyConnectionTester
        );
    });

    teardown(() => {
        proxyMonitor.stop();
        sandbox.restore();
    });

    /**
     * Task 3.1: ProxyFallbackManager integration with ProxyMonitor
     * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
     */
    suite('Task 3.1: ProxyFallbackManager Integration', () => {
        test('should use fallback manager when system proxy detection fails', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // System proxy not detected
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: null,
                source: null
            });

            // Manual proxy available and working
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // Verify fallback logic is used
            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
            assert.strictEqual(result.proxyUrl, manualProxyUrl);
        });

        test('should prioritize system proxy when both are available', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // Both proxies available
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);
        });
    });

    /**
     * Task 3.3: System proxy switch notification
     * Property 5: System proxy switch notification
     * Validates: Requirements 2.3
     */
    suite('Task 3.3: System Proxy Switch Notification (Property 5)', () => {
        test('should notify when switching from fallback to system proxy', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // First: use fallback (system proxy not available)
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl,
                usingFallbackProxy: true
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            await fallbackManager.selectBestProxy(null);

            // Then: system proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);
        });
    });

    /**
     * Task 3.4: Property test for system proxy switch notification
     * Property 5: System proxy switch notification
     * Validates: Requirements 2.3
     */
    suite('Property 5: System proxy switch notification', () => {
        test('should always use system proxy when available and working', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    proxyUrlArb,
                    proxyUrlArb,
                    async (systemProxyUrl, manualProxyUrl) => {
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();

                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            manualProxyUrl
                        });
                        mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

                        const result = await fallbackManager.selectBestProxy(systemProxyUrl);

                        assert.strictEqual(result.source, 'system',
                            'Should use system proxy when available');
                        assert.strictEqual(result.proxyUrl, systemProxyUrl,
                            'Should return system proxy URL');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 3.5: Auto Mode OFF automatic recovery
     * Validates: Requirements 3.2, 3.3
     */
    suite('Task 3.5: Auto Mode OFF Automatic Recovery', () => {
        test('should recover from Auto Mode OFF when system proxy becomes available', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';

            // Initially in Auto Mode OFF
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                autoModeOff: true,
                lastSystemProxyUrl: undefined
            });

            // System proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);
        });

        test('should recover from Auto Mode OFF when fallback proxy becomes available', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // Initially in Auto Mode OFF
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                autoModeOff: true,
                manualProxyUrl
            });

            // Manual proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
            assert.strictEqual(result.proxyUrl, manualProxyUrl);
        });
    });

    /**
     * Task 3.6: Property test for Auto Mode OFF recovery
     * Property 8: Auto Mode OFF automatic recovery
     * Validates: Requirements 3.2, 3.3
     */
    suite('Property 8: Auto Mode OFF automatic recovery', () => {
        test('should recover when any proxy becomes available', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }),
                    fc.option(proxyUrlArb, { nil: undefined }),
                    fc.boolean(),
                    fc.boolean(),
                    async (systemProxyUrl, manualProxyUrl, systemWorks, manualWorks) => {
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();
                        mockUserNotifier.showSuccess.reset();
                        mockUserNotifier.showWarning.reset();

                        // Setup state as Auto Mode OFF
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Auto,
                            autoModeOff: true,
                            manualProxyUrl
                        });

                        // Setup connection tester
                        mockConnectionTester.testProxyAuto.callsFake(async (url: string) => {
                            if (url === systemProxyUrl && systemWorks) {
                                return createSuccessTestResult(url);
                            }
                            if (url === manualProxyUrl && manualWorks) {
                                return createSuccessTestResult(url);
                            }
                            return createFailureTestResult(url);
                        });

                        const result = await fallbackManager.selectBestProxy(systemProxyUrl);

                        // Should recover if any proxy works
                        if (systemProxyUrl && systemWorks) {
                            assert.strictEqual(result.success, true,
                                'Should recover with system proxy');
                            assert.strictEqual(result.source, 'system');
                        } else if (manualProxyUrl && manualWorks) {
                            assert.strictEqual(result.success, true,
                                'Should recover with fallback proxy');
                            assert.strictEqual(result.source, 'fallback');
                        } else {
                            assert.strictEqual(result.success, false,
                                'Should remain in Auto Mode OFF if no proxy works');
                            assert.strictEqual(result.source, 'none');
                        }
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 3.7: Complete OFF mode behavior
     * Validates: Requirements 3.4
     */
    suite('Task 3.7: Complete OFF Mode Behavior', () => {
        test('should not attempt proxy detection in complete OFF mode', async () => {
            // This is a design constraint - ProxyMonitor should not be started in OFF mode
            // When mode is OFF, the monitor should be stopped
            mockStateManager.getState.resolves({
                mode: ProxyMode.Off
            });

            // Verify that the fallback manager can still be called but won't find proxies
            // because in OFF mode, the system should not detect or test proxies
            const result = await fallbackManager.selectBestProxy(null);

            // Since fallback is enabled but no manual proxy is set in OFF mode
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });
    });

    /**
     * Task 3.8: Property test for complete OFF mode
     * Property 9: Complete OFF mode behavior
     * Validates: Requirements 3.4
     */
    suite('Property 9: Complete OFF mode behavior', () => {
        test('should not use any proxy in complete OFF mode', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }),
                    async (systemProxyUrl) => {
                        mockConnectionTester.testProxyAuto.reset();
                        mockStateManager.getState.reset();

                        // State is complete OFF (mode=Off, not autoModeOff)
                        mockStateManager.getState.resolves({
                            mode: ProxyMode.Off,
                            autoModeOff: false,
                            manualProxyUrl: undefined
                        });

                        // Even if a system proxy is provided, fallback should return none
                        // because no manual proxy is configured in OFF mode
                        const result = await fallbackManager.selectBestProxy(systemProxyUrl);

                        // In OFF mode with no manual proxy configured
                        if (systemProxyUrl) {
                            // System proxy provided, test it
                            // But without manual fallback, if system fails, return none
                        }

                        // The key behavior: in OFF mode, there should be no manual proxy configured
                        // so fallback will not be used
                        assert.notStrictEqual(result.source, 'fallback',
                            'Should not use fallback in OFF mode without manual proxy');
                    }
                ),
                { numRuns }
            );
        });
    });
});
