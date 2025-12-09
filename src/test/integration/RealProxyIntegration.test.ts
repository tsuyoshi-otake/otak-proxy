/**
 * @file RealProxyIntegration.test.ts
 * @description Integration tests with real proxy server
 *
 * Usage:
 *   # Run with real proxy
 *   REAL_PROXY_URL=http://10.255.10.21:8080 npm test -- --grep "Real Proxy"
 *
 *   # Or set environment variable and run all tests
 *   set REAL_PROXY_URL=http://10.255.10.21:8080
 *   npm test
 *
 * Tests are skipped if REAL_PROXY_URL is not set.
 */

import * as assert from 'assert';
import {
    testProxyConnectionParallel,
    getDefaultTestUrls,
    getDefaultAutoTimeout,
    getDefaultManualTimeout
} from '../../utils/ProxyUtils';
import { ProxyFallbackManager } from '../../monitoring/ProxyFallbackManager';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { UserNotifier } from '../../errors/UserNotifier';
import { ProxyMode } from '../../core/types';
import * as sinon from 'sinon';

/**
 * Get real proxy URL from environment variable
 */
function getRealProxyUrl(): string | undefined {
    return process.env.REAL_PROXY_URL;
}

/**
 * Check if real proxy tests should run
 */
function shouldRunRealProxyTests(): boolean {
    const proxyUrl = getRealProxyUrl();
    if (!proxyUrl) {
        console.log('⏭️  REAL_PROXY_URL not set, skipping real proxy tests');
        return false;
    }
    console.log(`✅ Running real proxy tests with: ${proxyUrl}`);
    return true;
}

suite('Real Proxy Integration Tests', function() {
    // Increase timeout for real network tests
    this.timeout(30000);

    const realProxyUrl = getRealProxyUrl();
    const skipTests = !shouldRunRealProxyTests();

    suite('Direct Proxy Connection Tests', () => {
        test('should connect through real proxy with auto timeout', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await testProxyConnectionParallel(
                realProxyUrl!,
                getDefaultTestUrls(),
                getDefaultAutoTimeout()
            );

            console.log(`📊 Auto test result:`, {
                success: result.success,
                duration: result.duration,
                testUrls: result.testUrls,
                errors: result.errors
            });

            assert.strictEqual(result.success, true,
                `Proxy connection should succeed. Errors: ${JSON.stringify(result.errors)}`);
            assert.ok(result.duration && result.duration > 0, 'Duration should be recorded');
            assert.strictEqual(result.proxyUrl, realProxyUrl);
        });

        test('should connect through real proxy with manual timeout', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await testProxyConnectionParallel(
                realProxyUrl!,
                getDefaultTestUrls(),
                getDefaultManualTimeout()
            );

            console.log(`📊 Manual test result:`, {
                success: result.success,
                duration: result.duration,
                testUrls: result.testUrls,
                errors: result.errors
            });

            assert.strictEqual(result.success, true,
                `Proxy connection should succeed. Errors: ${JSON.stringify(result.errors)}`);
        });

        test('should test multiple URLs in parallel', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const customUrls = [
                'https://www.github.com',
                'https://www.google.com',
                'https://www.microsoft.com'
            ];

            const result = await testProxyConnectionParallel(
                realProxyUrl!,
                customUrls,
                getDefaultManualTimeout()
            );

            console.log(`📊 Multi-URL test result:`, {
                success: result.success,
                duration: result.duration,
                testUrls: result.testUrls,
                successCount: result.testUrls.length - result.errors.length,
                errorCount: result.errors.length
            });

            // At least one URL should succeed
            assert.ok(
                result.testUrls.length > result.errors.length,
                'At least one URL should be reachable'
            );
        });
    });

    suite('ProxyConnectionTester with Real Proxy', () => {
        let connectionTester: ProxyConnectionTester;
        let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;
        let sandbox: sinon.SinonSandbox;

        setup(() => {
            sandbox = sinon.createSandbox();
            mockUserNotifier = sandbox.createStubInstance(UserNotifier);
            connectionTester = new ProxyConnectionTester(
                mockUserNotifier as unknown as UserNotifier
            );
        });

        teardown(() => {
            sandbox.restore();
        });

        test('should test real proxy in auto mode', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await connectionTester.testProxyAuto(realProxyUrl!);

            console.log(`📊 ProxyConnectionTester auto result:`, {
                success: result.success,
                duration: result.duration
            });

            assert.strictEqual(result.success, true);

            // Cache should be updated
            const cachedResult = connectionTester.getLastTestResult(realProxyUrl!);
            assert.ok(cachedResult, 'Result should be cached');
            assert.strictEqual(cachedResult.success, true);
        });

        test('should test real proxy in manual mode', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await connectionTester.testProxyManual(realProxyUrl!);

            console.log(`📊 ProxyConnectionTester manual result:`, {
                success: result.success,
                duration: result.duration
            });

            assert.strictEqual(result.success, true);

            // Should show success notification for manual test
            sinon.assert.called(mockUserNotifier.showSuccess);
        });
    });

    suite('ProxyFallbackManager with Real Proxy', () => {
        let fallbackManager: ProxyFallbackManager;
        let connectionTester: ProxyConnectionTester;
        let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
        let mockUserNotifier: sinon.SinonStubbedInstance<UserNotifier>;
        let sandbox: sinon.SinonSandbox;

        setup(() => {
            sandbox = sinon.createSandbox();
            mockUserNotifier = sandbox.createStubInstance(UserNotifier);
            mockStateManager = sandbox.createStubInstance(ProxyStateManager);

            // Use real connection tester
            connectionTester = new ProxyConnectionTester(
                mockUserNotifier as unknown as UserNotifier
            );

            // Mock state manager to return real proxy as manual proxy
            mockStateManager.getState.resolves({
                mode: ProxyMode.Auto,
                manualProxyUrl: realProxyUrl
            });

            fallbackManager = new ProxyFallbackManager(
                connectionTester,
                mockStateManager as unknown as ProxyStateManager,
                mockUserNotifier as unknown as UserNotifier,
                true
            );
        });

        teardown(() => {
            sandbox.restore();
        });

        test('should select real proxy as system proxy', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await fallbackManager.selectBestProxy(realProxyUrl!);

            console.log(`📊 FallbackManager system proxy result:`, {
                success: result.success,
                source: result.source,
                proxyUrl: result.proxyUrl
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'system');
            assert.strictEqual(result.proxyUrl, realProxyUrl);
        });

        test('should fallback to real proxy when system proxy is null', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const result = await fallbackManager.selectBestProxy(null);

            console.log(`📊 FallbackManager fallback result:`, {
                success: result.success,
                source: result.source,
                proxyUrl: result.proxyUrl
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.source, 'fallback');
            assert.strictEqual(result.proxyUrl, realProxyUrl);
        });

        test('should not fallback when fallback is disabled', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            fallbackManager.setFallbackEnabled(false);

            const result = await fallbackManager.selectBestProxy(null);

            console.log(`📊 FallbackManager disabled result:`, {
                success: result.success,
                source: result.source
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.source, 'none');
        });
    });

    suite('Performance Tests with Real Proxy', () => {
        test('should complete test within acceptable time', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const startTime = Date.now();
            const result = await testProxyConnectionParallel(
                realProxyUrl!,
                getDefaultTestUrls(),
                getDefaultAutoTimeout()
            );
            const totalTime = Date.now() - startTime;

            console.log(`📊 Performance test:`, {
                success: result.success,
                testDuration: result.duration,
                totalTime,
                testUrls: result.testUrls.length
            });

            // Should complete within auto timeout (3 seconds) + buffer
            assert.ok(totalTime < 5000, `Test should complete within 5 seconds, took ${totalTime}ms`);
        });

        test('should handle multiple sequential tests efficiently', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const iterations = 3;
            const results: number[] = [];

            for (let i = 0; i < iterations; i++) {
                const startTime = Date.now();
                await testProxyConnectionParallel(
                    realProxyUrl!,
                    ['https://www.github.com'],
                    getDefaultAutoTimeout()
                );
                results.push(Date.now() - startTime);
            }

            const avgTime = results.reduce((a, b) => a + b, 0) / results.length;
            console.log(`📊 Sequential test times: ${results.join('ms, ')}ms (avg: ${avgTime.toFixed(0)}ms)`);

            assert.ok(avgTime < 3000, `Average should be under 3 seconds, was ${avgTime}ms`);
        });
    });

    suite('Error Handling with Invalid Proxy', () => {
        test('should fail gracefully with invalid proxy', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const invalidProxyUrl = 'http://invalid.proxy.local:9999';

            const result = await testProxyConnectionParallel(
                invalidProxyUrl,
                ['https://www.github.com'],
                3000 // Short timeout
            );

            console.log(`📊 Invalid proxy result:`, {
                success: result.success,
                errors: result.errors
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.errors.length > 0, 'Should have errors');
        });

        test('should handle proxy comparison (real vs invalid)', async function() {
            if (skipTests) {
                this.skip();
                return;
            }

            const invalidProxyUrl = 'http://127.0.0.1:9999';

            // Test real proxy
            const realResult = await testProxyConnectionParallel(
                realProxyUrl!,
                ['https://www.github.com'],
                getDefaultAutoTimeout()
            );

            // Test invalid proxy
            const invalidResult = await testProxyConnectionParallel(
                invalidProxyUrl,
                ['https://www.github.com'],
                3000
            );

            console.log(`📊 Comparison:`, {
                realProxy: { success: realResult.success, duration: realResult.duration },
                invalidProxy: { success: invalidResult.success, errors: invalidResult.errors.length }
            });

            assert.strictEqual(realResult.success, true, 'Real proxy should succeed');
            assert.strictEqual(invalidResult.success, false, 'Invalid proxy should fail');
        });
    });
});
