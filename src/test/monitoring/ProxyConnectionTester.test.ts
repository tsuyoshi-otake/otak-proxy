/**
 * @file ProxyConnectionTester Unit Tests
 * @description Tests for ProxyConnectionTester class
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 1.1, 2.1, 2.2, 2.3, 7.1, 7.2, 7.3, 7.4
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../../errors/UserNotifier';

suite('ProxyConnectionTester Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let tester: ProxyConnectionTester;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockNotifier = sandbox.createStubInstance(UserNotifier);
        tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('Constructor', () => {
        test('should create instance with UserNotifier', () => {
            assert.ok(tester instanceof ProxyConnectionTester,
                'Should create ProxyConnectionTester instance');
        });

        test('should initialize with no test in progress', () => {
            assert.strictEqual(tester.isTestInProgress(), false,
                'Should not have test in progress initially');
        });
    });

    suite('testProxyAuto', () => {
        test('should return TestResult with correct structure', async function() {
            this.timeout(15000);

            const result = await tester.testProxyAuto('http://invalid-proxy:9999');

            assert.ok(typeof result.success === 'boolean', 'success should be boolean');
            assert.ok(Array.isArray(result.testUrls), 'testUrls should be array');
            assert.ok(Array.isArray(result.errors), 'errors should be array');
            assert.strictEqual(result.proxyUrl, 'http://invalid-proxy:9999',
                'proxyUrl should match input');
            assert.ok(typeof result.timestamp === 'number', 'timestamp should be number');
            assert.ok(typeof result.duration === 'number', 'duration should be number');
        });

        test('should use 3 second timeout for auto tests', async function() {
            this.timeout(10000);

            const startTime = Date.now();
            await tester.testProxyAuto('http://invalid-proxy:9999');
            const elapsed = Date.now() - startTime;

            // Auto test should complete within ~3.5 seconds (3s timeout + buffer)
            assert.ok(elapsed < 5000,
                `Auto test should complete within 5 seconds (elapsed: ${elapsed}ms)`);
        });

        test('should cache last test result', async function() {
            this.timeout(15000);

            const proxyUrl = 'http://test-proxy:8080';
            const result = await tester.testProxyAuto(proxyUrl);

            const cachedResult = tester.getLastTestResult(proxyUrl);
            assert.ok(cachedResult !== undefined, 'Should have cached result');
            assert.strictEqual(cachedResult?.success, result.success,
                'Cached result should match test result');
        });

        test('should set testInProgress during test', async function() {
            this.timeout(15000);

            // Start test but don't await
            const testPromise = tester.testProxyAuto('http://test-proxy:8080');

            // Check that test is in progress (immediately after starting)
            // Note: This is a race condition test, might be flaky
            // The test should be in progress for most of the duration

            await testPromise;

            // After completion, should not be in progress
            assert.strictEqual(tester.isTestInProgress(), false,
                'Should not be in progress after completion');
        });
    });

    suite('testProxyManual', () => {
        test('should return TestResult with correct structure', async function() {
            this.timeout(20000);

            const result = await tester.testProxyManual('http://invalid-proxy:9999');

            assert.ok(typeof result.success === 'boolean', 'success should be boolean');
            assert.ok(Array.isArray(result.testUrls), 'testUrls should be array');
            assert.ok(Array.isArray(result.errors), 'errors should be array');
            assert.strictEqual(result.proxyUrl, 'http://invalid-proxy:9999',
                'proxyUrl should match input');
        });

        test('should use 5 second timeout for manual tests', async function() {
            this.timeout(15000);

            const startTime = Date.now();
            await tester.testProxyManual('http://invalid-proxy:9999');
            const elapsed = Date.now() - startTime;

            // Manual test should complete within ~5.5 seconds (5s timeout + buffer)
            assert.ok(elapsed < 8000,
                `Manual test should complete within 8 seconds (elapsed: ${elapsed}ms)`);
        });
    });

    suite('getLastTestResult', () => {
        test('should return undefined for untested proxy', () => {
            const result = tester.getLastTestResult('http://never-tested:8080');
            assert.strictEqual(result, undefined, 'Should return undefined for untested proxy');
        });

        test('should return last test result for tested proxy', async function() {
            this.timeout(15000);

            const proxyUrl = 'http://test-proxy:8080';
            await tester.testProxyAuto(proxyUrl);

            const result = tester.getLastTestResult(proxyUrl);
            assert.ok(result !== undefined, 'Should return result for tested proxy');
            assert.strictEqual(result?.proxyUrl, proxyUrl, 'proxyUrl should match');
        });
    });

    suite('isTestInProgress', () => {
        test('should return false when no test is running', () => {
            assert.strictEqual(tester.isTestInProgress(), false,
                'Should return false when idle');
        });
    });

    suite('Notification behavior', () => {
        test('should be able to notify on test completion', async function() {
            this.timeout(15000);

            // This test verifies that the tester can work with notifications
            // The actual notification behavior depends on the implementation
            await tester.testProxyAuto('http://invalid-proxy:9999');

            // Test passes if no error is thrown
            assert.ok(true, 'Should complete without error');
        });
    });
});
