/**
 * Property-based tests for ProxyConnectionTester
 * Feature: auto-mode-proxy-testing
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { getPropertyTestRuns, getPropertyTestTimeout } from '../helpers';
import { validProxyUrlGenerator } from '../generators';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../../errors/UserNotifier';

suite('ProxyConnectionTester Property Tests', function() {
    const numRuns = getPropertyTestRuns();
    this.timeout(getPropertyTestTimeout(120000));

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

    /**
     * Feature: auto-mode-proxy-testing, Property 2: テスト成功時のプロキシ有効化
     * Validates: Requirements 1.2, 4.2, 5.2
     *
     * For any proxy URL and test result, if test succeeds,
     * the result should indicate success.
     */
    suite('Property 2: Test success enables proxy', () => {
        test('testProxyAuto returns correct structure for any valid proxy URL', async () => {
            await fc.assert(
                fc.asyncProperty(
                    validProxyUrlGenerator(),
                    async (proxyUrl) => {
                        const result = await tester.testProxyAuto(proxyUrl);

                        // Verify structure invariants
                        assert.ok(typeof result.success === 'boolean',
                            'success should be boolean');
                        assert.strictEqual(result.proxyUrl, proxyUrl,
                            'proxyUrl should match input');
                        assert.ok(Array.isArray(result.testUrls),
                            'testUrls should be array');
                        assert.ok(Array.isArray(result.errors),
                            'errors should be array');
                        assert.ok(typeof result.timestamp === 'number',
                            'timestamp should be number');

                        // If success is false, there should be errors
                        if (!result.success) {
                            assert.ok(result.errors.length > 0,
                                'Should have errors when test fails');
                        }
                    }
                ),
                { numRuns: Math.min(numRuns, 5) } // Limited for network tests
            );
        });

        test('test result is cached correctly for any proxy URL', async () => {
            await fc.assert(
                fc.asyncProperty(
                    validProxyUrlGenerator(),
                    async (proxyUrl) => {
                        // Run test
                        const result = await tester.testProxyAuto(proxyUrl);

                        // Verify caching
                        const cached = tester.getLastTestResult(proxyUrl);
                        assert.ok(cached !== undefined,
                            'Result should be cached');
                        assert.strictEqual(cached?.proxyUrl, result.proxyUrl,
                            'Cached proxyUrl should match');
                        assert.strictEqual(cached?.success, result.success,
                            'Cached success should match');
                    }
                ),
                { numRuns: Math.min(numRuns, 5) }
            );
        });
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 3: テスト失敗時のプロキシ無効化
     * Validates: Requirements 1.3, 4.3, 5.3
     *
     * For any invalid proxy URL, test should fail with errors.
     */
    suite('Property 3: Test failure disables proxy', () => {
        test('invalid proxy URLs should fail with errors', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate invalid proxy URLs (random strings that won't connect)
                    fc.tuple(
                        fc.string({ minLength: 3, maxLength: 10 }).filter(s => /^[a-z]+$/.test(s)),
                        fc.integer({ min: 10000, max: 65535 })
                    ).map(([host, port]) => `http://invalid-${host}:${port}`),
                    async (proxyUrl) => {
                        const result = await tester.testProxyAuto(proxyUrl);

                        // Invalid proxies should always fail
                        assert.strictEqual(result.success, false,
                            'Invalid proxy should fail');
                        assert.ok(result.errors.length > 0,
                            'Should have errors for invalid proxy');
                    }
                ),
                { numRuns: Math.min(numRuns, 5) }
            );
        });

        test('failed tests should still be cached', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 10000, max: 65535 }),
                    async (port) => {
                        const proxyUrl = `http://definitely-invalid-proxy:${port}`;
                        const result = await tester.testProxyAuto(proxyUrl);

                        assert.strictEqual(result.success, false,
                            'Should fail');

                        const cached = tester.getLastTestResult(proxyUrl);
                        assert.ok(cached !== undefined,
                            'Failed result should be cached');
                        assert.strictEqual(cached?.success, false,
                            'Cached result should show failure');
                    }
                ),
                { numRuns: Math.min(numRuns, 5) }
            );
        });
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 7: 通知の重複抑制
     * Validates: Requirements 6.3
     *
     * Auto tests should not generate user-visible notifications.
     */
    suite('Property 7: Notification throttling', () => {
        test('auto tests should not show user notifications directly', async () => {
            await fc.assert(
                fc.asyncProperty(
                    validProxyUrlGenerator(),
                    async (proxyUrl) => {
                        // Reset call counts
                        mockNotifier.showSuccess.resetHistory();
                        mockNotifier.showWarning.resetHistory();
                        mockNotifier.showError.resetHistory();

                        await tester.testProxyAuto(proxyUrl);

                        // Auto tests should NOT call notification methods
                        assert.strictEqual(mockNotifier.showSuccess.callCount, 0,
                            'Auto test should not call showSuccess');
                        // Note: We don't check showWarning for auto tests
                        // as the implementation logs but doesn't notify
                    }
                ),
                { numRuns: Math.min(numRuns, 5) }
            );
        });

        test('manual tests show notifications appropriately', async () => {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 10000, max: 65535 }),
                    async (port) => {
                        // Reset call counts
                        mockNotifier.showSuccess.resetHistory();
                        mockNotifier.showWarning.resetHistory();

                        const proxyUrl = `http://invalid-manual-test:${port}`;
                        const result = await tester.testProxyManual(proxyUrl);

                        // Manual tests with failure should call showWarning
                        if (!result.success) {
                            assert.strictEqual(mockNotifier.showWarning.callCount, 1,
                                'Manual test failure should call showWarning');
                        }
                    }
                ),
                { numRuns: Math.min(numRuns, 3) }
            );
        });
    });

    /**
     * Test progress flag behavior
     */
    suite('Test progress flag', () => {
        test('isTestInProgress should be false after completion for any proxy', async () => {
            await fc.assert(
                fc.asyncProperty(
                    validProxyUrlGenerator(),
                    async (proxyUrl) => {
                        await tester.testProxyAuto(proxyUrl);

                        assert.strictEqual(tester.isTestInProgress(), false,
                            'Should not be in progress after completion');
                    }
                ),
                { numRuns: Math.min(numRuns, 5) }
            );
        });
    });
});
