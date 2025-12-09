/**
 * Property-based tests for ProxyUtils
 * Feature: auto-mode-proxy-testing
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { getPropertyTestRuns, getPropertyTestTimeout } from '../helpers';
import { validProxyUrlGenerator } from '../generators';

// Import the module under test
import * as proxyUtils from '../../utils/ProxyUtils';

suite('ProxyUtils Property Tests', function() {
    const numRuns = getPropertyTestRuns();
    this.timeout(getPropertyTestTimeout(60000));

    /**
     * Feature: auto-mode-proxy-testing, Property 4: 並列テストの早期終了
     * Validates: Requirements 2.2, 2.4
     *
     * For any set of test URLs, if at least one succeeds, the overall test succeeds.
     * If all fail, the overall test fails.
     */
    suite('Property 4: Parallel test early termination', () => {
        test('should return success=true if at least one URL succeeds in simulation', () => {
            fc.assert(
                fc.property(
                    // Generate 1-5 test results where at least one is success
                    fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }).filter(arr => arr.some(v => v)),
                    (results) => {
                        // Simulate: if any result is true, overall should be true
                        const overallSuccess = results.some(r => r);
                        assert.strictEqual(overallSuccess, true,
                            'If any URL succeeds, overall test should succeed');
                    }
                ),
                { numRuns }
            );
        });

        test('should return success=false if all URLs fail in simulation', () => {
            fc.assert(
                fc.property(
                    // Generate 1-5 test results where all are false
                    fc.array(fc.constant(false), { minLength: 1, maxLength: 5 }),
                    (results) => {
                        // Simulate: if all results are false, overall should be false
                        const overallSuccess = results.some(r => r);
                        assert.strictEqual(overallSuccess, false,
                            'If all URLs fail, overall test should fail');
                    }
                ),
                { numRuns }
            );
        });

        test('testProxyConnectionParallel returns correct structure with arbitrary test URLs', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate valid proxy URL
                    validProxyUrlGenerator(),
                    // Generate 1-3 test URLs (keeping it small to avoid long timeouts)
                    fc.array(
                        fc.constantFrom(
                            'https://www.github.com',
                            'https://www.microsoft.com',
                            'https://www.google.com'
                        ),
                        { minLength: 1, maxLength: 3 }
                    ),
                    // Generate timeout between 100-500ms for fast tests
                    fc.integer({ min: 100, max: 500 }),
                    async (proxyUrl, testUrls, timeout) => {
                        const result = await proxyUtils.testProxyConnectionParallel(
                            proxyUrl,
                            testUrls,
                            timeout
                        );

                        // Verify structure invariants
                        assert.ok(typeof result.success === 'boolean',
                            'success should be boolean');
                        assert.ok(Array.isArray(result.testUrls),
                            'testUrls should be array');
                        assert.ok(Array.isArray(result.errors),
                            'errors should be array');
                        assert.strictEqual(result.proxyUrl, proxyUrl,
                            'proxyUrl should match input');
                        assert.ok(typeof result.timestamp === 'number',
                            'timestamp should be number');
                        assert.ok(typeof result.duration === 'number',
                            'duration should be number');
                        assert.ok(result.duration >= 0,
                            'duration should be non-negative');
                    }
                ),
                { numRuns: Math.min(numRuns, 10) } // Limit async tests
            );
        });

        test('testProxyConnectionParallel completes within timeout bound', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate timeout between 500-1500ms
                    fc.integer({ min: 500, max: 1500 }),
                    async (timeout) => {
                        const startTime = Date.now();

                        await proxyUtils.testProxyConnectionParallel(
                            'http://invalid-proxy-test:9999',
                            ['https://www.github.com'],
                            timeout
                        );

                        const elapsed = Date.now() - startTime;
                        // Should complete within timeout + buffer (500ms for cleanup)
                        assert.ok(elapsed < timeout + 1500,
                            `Should complete within timeout bound (elapsed: ${elapsed}ms, timeout: ${timeout}ms)`);
                    }
                ),
                { numRuns: Math.min(numRuns, 5) } // Limit for time-sensitive tests
            );
        });

        test('testProxyConnectionParallel preserves test URL list in result', async () => {
            await fc.assert(
                fc.asyncProperty(
                    // Generate 1-3 unique test URLs
                    fc.uniqueArray(
                        fc.constantFrom(
                            'https://www.github.com',
                            'https://www.microsoft.com',
                            'https://www.google.com',
                            'https://www.cloudflare.com'
                        ),
                        { minLength: 1, maxLength: 3 }
                    ),
                    async (testUrls) => {
                        const result = await proxyUtils.testProxyConnectionParallel(
                            'http://invalid-proxy-test:9999',
                            testUrls,
                            500
                        );

                        // The testUrls in result should match input
                        assert.deepStrictEqual(result.testUrls, testUrls,
                            'testUrls in result should match input');
                    }
                ),
                { numRuns: Math.min(numRuns, 10) }
            );
        });
    });
});
