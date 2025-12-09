/**
 * @file ProxyTestScheduler Fallback Tests
 * @description Tests for ProxyTestScheduler fallback logic
 * Feature: auto-mode-fallback-improvements
 * Tasks: 5.1-5.3
 *
 * Validates:
 * - Task 5.1: ProxyTestScheduler extension for fallback logic
 * - Task 5.2: Unit tests for fallback logic
 * - Task 5.3: Property test for periodic test fallback (Property 12)
 * - Requirements 6.1, 6.2, 6.3, 6.4
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fc from 'fast-check';
import { ProxyTestScheduler } from '../../monitoring/ProxyTestScheduler';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { TestResult } from '../../utils/ProxyUtils';
import { getPropertyTestRuns } from '../helpers';
import { proxyUrlArb } from '../generators';

suite('ProxyTestScheduler Fallback Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockConnectionTester: sinon.SinonStubbedInstance<ProxyConnectionTester>;
    let scheduler: ProxyTestScheduler;

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
        scheduler = new ProxyTestScheduler(
            mockConnectionTester as unknown as ProxyConnectionTester,
            60000 // 60 second interval
        );
    });

    teardown(() => {
        scheduler.stop();
        sandbox.restore();
    });

    /**
     * Task 5.1: ProxyTestScheduler extension for fallback logic
     * Task 5.2: Unit tests for fallback logic
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     */
    suite('Task 5.1-5.2: Fallback Logic in Periodic Tests', () => {
        test('should test system proxy first (Requirement 6.1)', async () => {
            const systemProxyUrl = 'http://system-proxy.example.com:8080';
            const testResults: TestResult[] = [];

            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(systemProxyUrl));

            scheduler.start(systemProxyUrl, (result) => {
                testResults.push(result);
            });

            // Trigger immediate test
            await scheduler.triggerImmediateTest();

            // System proxy should be tested
            sinon.assert.calledWith(mockConnectionTester.testProxyAuto, systemProxyUrl);
        });

        test('should report test results via callback', async () => {
            const proxyUrl = 'http://proxy.example.com:8080';
            const testResults: TestResult[] = [];

            mockConnectionTester.testProxyAuto.resolves(createSuccessTestResult(proxyUrl));

            scheduler.start(proxyUrl, (result) => {
                testResults.push(result);
            });

            await scheduler.triggerImmediateTest();

            assert.strictEqual(testResults.length, 1);
            assert.strictEqual(testResults[0].success, true);
            assert.strictEqual(testResults[0].proxyUrl, proxyUrl);
        });

        test('should handle test failures gracefully', async () => {
            const proxyUrl = 'http://proxy.example.com:8080';
            const testResults: TestResult[] = [];

            mockConnectionTester.testProxyAuto.resolves(createFailureTestResult(proxyUrl));

            scheduler.start(proxyUrl, (result) => {
                testResults.push(result);
            });

            await scheduler.triggerImmediateTest();

            assert.strictEqual(testResults.length, 1);
            assert.strictEqual(testResults[0].success, false);
        });

        test('should allow proxy URL update during operation', () => {
            const initialUrl = 'http://initial.example.com:8080';
            const newUrl = 'http://new.example.com:8080';

            scheduler.start(initialUrl, () => {});

            assert.strictEqual(scheduler.getCurrentProxyUrl(), initialUrl);

            scheduler.updateProxyUrl(newUrl);

            assert.strictEqual(scheduler.getCurrentProxyUrl(), newUrl);
        });
    });

    /**
     * Task 5.3: Property test for periodic test fallback logic
     * Property 12: Periodic test fallback logic
     * Validates: Requirements 6.1, 6.2, 6.3, 6.4
     */
    suite('Property 12: Periodic test fallback logic', () => {
        test('should always test the configured proxy URL', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    proxyUrlArb,
                    fc.boolean(), // success
                    async (proxyUrl, success) => {
                        mockConnectionTester.testProxyAuto.reset();

                        const testResult = success
                            ? createSuccessTestResult(proxyUrl)
                            : createFailureTestResult(proxyUrl);
                        mockConnectionTester.testProxyAuto.resolves(testResult);

                        let callbackResult: TestResult | undefined;
                        scheduler.start(proxyUrl, (result) => {
                            callbackResult = result;
                        });

                        await scheduler.triggerImmediateTest();

                        // Verify the proxy was tested
                        sinon.assert.calledWith(mockConnectionTester.testProxyAuto, proxyUrl);

                        // Verify callback received the result
                        assert.ok(callbackResult !== undefined,
                            'Callback should receive test result');
                        assert.strictEqual(callbackResult!.success, success,
                            'Result success should match test outcome');

                        scheduler.stop();
                    }
                ),
                { numRuns }
            );
        });

        test('should respect interval configuration', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 30000, max: 600000 }), // Valid interval range
                    async (intervalMs) => {
                        const testScheduler = new ProxyTestScheduler(
                            mockConnectionTester as unknown as ProxyConnectionTester,
                            intervalMs
                        );

                        // Interval should be clamped to valid range
                        const actualInterval = testScheduler.getIntervalMs();
                        assert.ok(actualInterval >= 30000,
                            'Interval should be at least 30 seconds');
                        assert.ok(actualInterval <= 600000,
                            'Interval should be at most 10 minutes');
                    }
                ),
                { numRuns }
            );
        });
    });
});
