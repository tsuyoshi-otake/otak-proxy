/**
 * @file ProxyFallbackManager Tests
 * @description Unit tests for ProxyFallbackManager
 * Feature: auto-mode-fallback-improvements
 * Task: 1.2
 *
 * Validates:
 * - Requirements 1.1, 1.2, 1.3, 1.4, 1.5 (Fallback proxy functionality)
 * - Requirements 5.1, 5.2, 5.3, 5.4 (Priority-based proxy selection)
 * - Requirements 8.2, 8.3, 8.4 (Fallback enable/disable)
 * - Requirements 2.1, 2.4 (Notifications)
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyFallbackManager, ProxySelectionResult } from '../../monitoring/ProxyFallbackManager';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';
import { ProxyMode } from '../../core/types';

suite('ProxyFallbackManager Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let fallbackManager: ProxyFallbackManager;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;

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

        // Create mock instances
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

    suite('selectBestProxy', () => {
        // Requirement 5.2: System proxy should be prioritized over manual proxy
        test('should use system proxy when available and reachable', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, systemProxyUrl);
        });

        // Requirement 1.1: When system proxy is not detected, check for manual proxy
        test('should check manual proxy when system proxy is null', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
            assert.strictEqual(result.proxyUrl, manualProxyUrl);
        });

        // Requirement 1.2: When manual proxy exists, test connection
        test('should test manual proxy connection when system proxy is not available', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            await fallbackManager.selectBestProxy(null);

            sinon.assert.calledWith(mockConnectionTester.testProxyAuto, manualProxyUrl);
        });

        // Requirement 1.4: When manual proxy test fails, use direct connection
        test('should return none source when manual proxy test fails', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            assert.strictEqual(result.proxyUrl, null);
        });

        // Requirement 1.5: When no manual proxy exists, use direct connection
        test('should return none source when no manual proxy configured', async () => {
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl: undefined
            });

            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            assert.strictEqual(result.proxyUrl, null);
        });

        // Requirement 5.1: Priority order: system proxy, manual proxy (fallback), direct connection
        test('should try system proxy first, then fallback to manual proxy on failure', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });

            // System proxy fails, manual proxy succeeds
            mockConnectionTester.testProxyAuto
                .onFirstCall().resolves(createFailureTestResult(systemProxyUrl))
                .onSecondCall().resolves(createSuccessTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
            assert.strictEqual(result.proxyUrl, manualProxyUrl);
        });

        // Requirement 5.3: When system proxy unavailable and manual proxy available, use manual
        test('should use manual proxy when system proxy is unreachable', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });

            mockConnectionTester.testProxyAuto
                .onFirstCall().resolves(createFailureTestResult(systemProxyUrl))
                .onSecondCall().resolves(createSuccessTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.proxyUrl, manualProxyUrl);
        });

        // Requirement 5.4: When both proxies unavailable, use direct connection
        test('should return none when both proxies are unavailable', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';

            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });

            mockConnectionTester.testProxyAuto
                .onFirstCall().resolves(createFailureTestResult(systemProxyUrl))
                .onSecondCall().resolves(createFailureTestResult(manualProxyUrl));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            assert.strictEqual(result.proxyUrl, null);
        });
    });

    suite('setFallbackEnabled / isFallbackEnabled', () => {
        // Requirement 8.2: When fallback disabled, don't use manual proxy
        test('should not try manual proxy when fallback is disabled', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });

            fallbackManager.setFallbackEnabled(false);
            const result = await fallbackManager.selectBestProxy(null);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
            sinon.assert.notCalled(mockConnectionTester.testProxyAuto);
        });

        test('should return false for isFallbackEnabled when disabled', () => {
            fallbackManager.setFallbackEnabled(false);
            assert.strictEqual(fallbackManager.isFallbackEnabled(), false);
        });

        test('should return true for isFallbackEnabled when enabled', () => {
            fallbackManager.setFallbackEnabled(true);
            assert.strictEqual(fallbackManager.isFallbackEnabled(), true);
        });

        // Requirement 8.4: Fallback setting should be applied immediately
        test('should apply fallback setting immediately', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            // First call with fallback enabled
            const result1 = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result1.success, true);

            // Disable fallback
            fallbackManager.setFallbackEnabled(false);

            // Second call should not try manual proxy
            const result2 = await fallbackManager.selectBestProxy(null);
            assert.strictEqual(result2.success, false);
            assert.strictEqual(result2.source, 'none');
        });
    });

    suite('notifications', () => {
        // Requirement 2.1: Notify when using fallback proxy
        test('should notify when fallback proxy is used', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(manualProxyUrl));

            await fallbackManager.selectBestProxy(null);

            sinon.assert.called(mockUserNotifier.showSuccess);
        });

        // Requirement 2.4: Notify when fallback proxy fails
        test('should notify when fallback proxy test fails', async () => {
            const manualProxyUrl = 'http://manual-proxy.example.com:8080';
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl
            });
            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(manualProxyUrl));

            await fallbackManager.selectBestProxy(null);

            sinon.assert.called(mockUserNotifier.showWarning);
        });

        // Should not notify when using system proxy (not a fallback)
        test('should not notify when using system proxy', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            await fallbackManager.selectBestProxy(systemProxyUrl);

            sinon.assert.notCalled(mockUserNotifier.showSuccess);
            sinon.assert.notCalled(mockUserNotifier.showWarning);
        });
    });

    suite('error handling', () => {
        test('should handle connection tester errors gracefully', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            mockConnectionTester.testProxyAuto.rejects(new Error('Network error'));

            const result = await fallbackManager.selectBestProxy(systemProxyUrl);

            // Should return failure, not throw
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });

        test('should handle state manager errors gracefully', async () => {
            mockStateManager.getState.rejects(new Error('Storage error'));

            const result = await fallbackManager.selectBestProxy(null);

            // Should return failure, not throw
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });
    });
});
