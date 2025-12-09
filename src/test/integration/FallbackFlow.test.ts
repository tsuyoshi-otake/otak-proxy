/**
 * @file FallbackFlow Integration Tests
 * @description End-to-end integration tests for fallback functionality
 * Feature: auto-mode-fallback-improvements
 * Tasks: 10.1-10.4
 *
 * Validates:
 * - Task 10.1: Fallback proxy usage flow
 * - Task 10.2: System proxy return flow
 * - Task 10.3: Auto Mode OFF flow
 * - Task 10.4: Fallback disable flow
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyFallbackManager } from '../../monitoring/ProxyFallbackManager';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';
import { ProxyMode, ProxyState } from '../../core/types';

suite('Fallback Flow Integration Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let fallbackManager: ProxyFallbackManager;
    let currentState: ProxyState;

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

        // Initialize state
        currentState = {
            mode: ProxyMode.Auto,
            manualProxyUrl: 'http://manual-proxy.example.com:8080'
        };

        // Create mock connection tester
        mockConnectionTester = sandbox.createStubInstance(ProxyConnectionTester);

        // Create mock state manager that tracks state changes
        mockStateManager = sandbox.createStubInstance(ProxyStateManager);
        mockStateManager.getState.callsFake(async () => ({ ...currentState }));
        mockStateManager.saveState.callsFake(async (state: ProxyState) => {
            currentState = { ...state };
        });

        // Create mock user notifier
        mockUserNotifier = sandbox.createStubInstance(UserNotifier);

        // Create fallback manager
        fallbackManager = new ProxyFallbackManager(
            mockConnectionTester as unknown as ProxyConnectionTester,
            mockStateManager as unknown as ProxyStateManager,
            mockUserNotifier as unknown as UserNotifier,
            true
        );
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Task 10.1: Fallback proxy usage flow
     * Flow: System proxy detection fails -> Manual proxy check -> Connection test -> Fallback enable -> Notification
     * Validates: Requirements 1.1, 1.2, 1.3, 2.1
     */
    suite('Task 10.1: Fallback Proxy Usage Flow', () => {
        test('should complete full fallback flow successfully', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // Step 1: System proxy not detected (null)
            // Step 2: Manual proxy exists in state
            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            // Step 3: Connection test succeeds
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // Execute flow
            const result = await fallbackManager.selectBestProxy(null);

            // Step 4: Fallback proxy enabled
            assert.strictEqual(result.success, true, 'Flow should succeed');
            assert.strictEqual(result.source, 'fallback', 'Should use fallback source');
            assert.strictEqual(result.proxyUrl, manualProxyUrl, 'Should use manual proxy URL');

            // Step 5: Notification shown
            sinon.assert.called(mockUserNotifier.showSuccess);
        });

        test('should handle fallback flow when manual proxy test fails', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            // Connection test fails
            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(null);

            // Should return none and show warning
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            sinon.assert.called(mockUserNotifier.showWarning);
        });

        test('should handle fallback flow when no manual proxy configured', async () => {
            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl: undefined
            };

            const result = await fallbackManager.selectBestProxy(null);

            // Should return none without testing
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            sinon.assert.notCalled(mockConnectionTester.testProxyAuto);
        });
    });

    /**
     * Task 10.2: System proxy return flow
     * Flow: Using fallback -> System proxy detected -> Connection test -> Switch to system -> Notification
     * Validates: Requirements 2.3, 5.2
     */
    suite('Task 10.2: System Proxy Return Flow', () => {
        test('should switch from fallback to system proxy', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            const systemProxyUrl = 'http://system-proxy.example.com:8080';

            // Initial state: using fallback
            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl,
                usingFallbackProxy: true,
                fallbackProxyUrl: manualProxyUrl
            };

            // System proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should use system proxy now
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);
        });

        test('should prioritize system proxy over fallback', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            const systemProxyUrl = 'http://system-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            // Both proxies work
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should use system proxy
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);

            // Should only test system proxy (not manual)
            sinon.assert.calledOnce(mockConnectionTester.testProxyAuto);
            sinon.assert.calledWith(mockConnectionTester.testProxyAuto, systemProxyUrl);
        });
    });

    /**
     * Task 10.3: Auto Mode OFF flow
     * Flow: Both proxies fail -> Auto Mode OFF -> System proxy detected -> Auto recovery -> Enable proxy
     * Validates: Requirements 3.1, 3.2, 3.3
     */
    suite('Task 10.3: Auto Mode OFF Flow', () => {
        test('should enter Auto Mode OFF when both proxies fail', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            // Both proxies fail
            mockConnectionTester.testProxyAuto
                .onFirstCall().resolves(createFailureTestResult(systemProxyUrl))
                .onSecondCall().resolves(createFailureTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should return none (Auto Mode OFF state)
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });

        test('should recover from Auto Mode OFF when system proxy becomes available', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';

            // Initial state: Auto Mode OFF
            currentState = {
                mode: ProxyMode.Auto,
                autoModeOff: true,
                lastSystemProxyUrl: undefined
            };

            // System proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should recover
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
        });

        test('should recover from Auto Mode OFF when fallback becomes available', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            // Initial state: Auto Mode OFF
            currentState = {
                mode: ProxyMode.Auto,
                autoModeOff: true,
                manualProxyUrl
            };

            // Manual proxy becomes available
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(null);

            // Should recover via fallback
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
        });
    });

    /**
     * Task 10.4: Fallback disable flow
     * Flow: Disable fallback -> System proxy fails -> No fallback attempt -> Auto Mode OFF
     * Validates: Requirements 8.2, 8.3
     */
    suite('Task 10.4: Fallback Disable Flow', () => {
        test('should not use fallback when disabled', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            // Disable fallback
            fallbackManager.setFallbackEnabled(false);

            // System proxy fails
            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should not try manual proxy
            sinon.assert.calledOnce(mockConnectionTester.testProxyAuto);
            sinon.assert.calledWith(mockConnectionTester.testProxyAuto, systemProxyUrl);

            // Should return none
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });

        test('should use fallback again after re-enabling', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // Disable then re-enable
            fallbackManager.setFallbackEnabled(false);
            fallbackManager.setFallbackEnabled(true);

            const result = await fallbackManager.selectBestProxy(null);

            // Should use fallback
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
        });

        test('should apply setting change immediately', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            currentState = {
                mode: ProxyMode.Auto,
                manualProxyUrl
            };

            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // Initially enabled
            let result = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result.source, 'fallback');

            // Disable
            fallbackManager.setFallbackEnabled(false);
            mockConnectionTester.testProxyAuto.resetHistory();

            result = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result.source, 'none');

            // Re-enable
            fallbackManager.setFallbackEnabled(true);

            result = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result.source, 'fallback');
        });
    });
});
