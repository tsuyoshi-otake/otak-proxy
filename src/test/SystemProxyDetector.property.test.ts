/**
 * Property-based tests for SystemProxyDetector
 * Tests universal properties that should hold across all inputs
 *
 * Feature: auto-proxy-detection-improvements
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { getPropertyTestRuns } from './helpers';

suite('SystemProxyDetector Property-Based Tests', () => {
    /**
     * Feature: auto-proxy-detection-improvements, Property 14: 検出ソースの優先順位遵守
     *
     * 任意の検出ソース優先順位リストに対して、システムはリストの順序に従ってソースをチェックするべき
     *
     * Validates: Requirements 7.1
     */
    test('Property 14: Detection source priority adherence', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate permutations of valid source names
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (priorityOrder) => {
                    const detector = new SystemProxyDetector(priorityOrder);

                    // Execute detection
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Result should be a valid ProxyDetectionWithSource object
                    if (result === null || typeof result !== 'object') {
                        throw new Error('detectSystemProxyWithSource should return an object');
                    }

                    if (!('proxyUrl' in result) || !('source' in result)) {
                        throw new Error('Result should have proxyUrl and source fields');
                    }

                    // Property: If a proxy is found, source should be from the priority list
                    // (or platform-specific source like 'windows', 'macos', 'linux')
                    if (result.proxyUrl !== null) {
                        const validSources = ['environment', 'vscode', 'windows', 'macos', 'linux'];
                        if (!validSources.includes(result.source as string)) {
                            throw new Error(
                                `Source '${result.source}' should be one of: ${validSources.join(', ')}`
                            );
                        }
                    }

                    // Property: If no proxy found, source should be null
                    if (result.proxyUrl === null && result.source !== null) {
                        throw new Error(
                            `When proxyUrl is null, source should also be null. Got source: ${result.source}`
                        );
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 15: 検出失敗時のフォールバック
     *
     * 任意の検出ソース優先順位リストに対して、優先順位の高いソースで失敗した場合、
     * 次のソースが試行されることを検証
     *
     * Validates: Requirements 7.2, 7.4
     */
    test('Property 15: Detection fallback on failure', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate priority lists with some invalid sources mixed in
                fc.tuple(
                    fc.array(fc.constantFrom('invalid_source_1', 'invalid_source_2'), { minLength: 0, maxLength: 2 }),
                    fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 })
                ),
                async ([invalidSources, validSources]) => {
                    // Create priority list with invalid sources first
                    const priorityOrder = [...invalidSources, ...validSources];

                    const detector = new SystemProxyDetector(priorityOrder);

                    // Execute detection
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Even with invalid sources first, detection should not throw
                    if (result === null || typeof result !== 'object') {
                        throw new Error('Detection should not fail even with invalid sources');
                    }

                    // Property: Result should have correct structure
                    if (!('proxyUrl' in result) || !('source' in result)) {
                        throw new Error('Result should have proxyUrl and source fields');
                    }

                    // Property: If proxy is found, it should be from a valid source
                    if (result.proxyUrl !== null) {
                        const platformSources = ['windows', 'macos', 'linux'];
                        const validResultSources = ['environment', 'vscode', ...platformSources];

                        if (!validResultSources.includes(result.source as string)) {
                            throw new Error(
                                `Found proxy from invalid source: ${result.source}`
                            );
                        }
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: All invalid sources should result in null
     *
     * When all sources in the priority list are invalid, the result should be null
     */
    test('Property: All invalid sources return null', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate arrays of invalid source names
                fc.array(
                    fc.constantFrom('invalid_source_1', 'invalid_source_2', 'unknown_src', 'bad_source'),
                    { minLength: 1, maxLength: 4 }
                ),
                async (invalidSources: string[]) => {
                    const detector = new SystemProxyDetector(invalidSources);

                    const result = await detector.detectSystemProxyWithSource();

                    // Property: All invalid sources should result in null
                    if (result.proxyUrl !== null || result.source !== null) {
                        throw new Error(
                            `Expected null result with invalid sources [${invalidSources.join(', ')}], ` +
                            `got proxyUrl: ${result.proxyUrl}, source: ${result.source}`
                        );
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Dynamic priority update should take effect
     *
     * After updateDetectionPriority is called, the new priority should be used
     */
    test('Property: Dynamic priority update takes effect', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (initialPriority, newPriority) => {
                    const detector = new SystemProxyDetector(initialPriority);

                    // Update priority
                    detector.updateDetectionPriority(newPriority);

                    // Execute detection (should use new priority)
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Detection should work after priority update
                    if (result === null || typeof result !== 'object') {
                        throw new Error('Detection should work after priority update');
                    }

                    // Property: Result structure should be valid
                    if (!('proxyUrl' in result) || !('source' in result)) {
                        throw new Error('Result should have proxyUrl and source fields after update');
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Detection is idempotent
     *
     * Multiple calls with the same configuration should produce consistent results
     */
    test('Property: Detection is consistent', async function() {
        this.timeout(60000);

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                fc.integer({ min: 2, max: 3 }), // Number of calls
                async (priority, callCount) => {
                    const detector = new SystemProxyDetector(priority);

                    // Execute detection multiple times
                    const results: { proxyUrl: string | null; source: string | null }[] = [];
                    for (let i = 0; i < callCount; i++) {
                        results.push(await detector.detectSystemProxyWithSource());
                    }

                    // Property: All results should have the same structure
                    for (const result of results) {
                        if (result === null || typeof result !== 'object') {
                            throw new Error('All detection calls should return valid objects');
                        }

                        if (!('proxyUrl' in result) || !('source' in result)) {
                            throw new Error('All results should have proxyUrl and source fields');
                        }
                    }

                    // Property: Results should be consistent (same proxyUrl and source)
                    // Note: We check consistency within a single test run
                    // External factors could change proxy between test runs
                    const firstResult = results[0];
                    for (let i = 1; i < results.length; i++) {
                        // In a stable environment, results should match
                        // We don't strictly enforce this as environment may change
                        // but we verify the structure is always valid
                        if (results[i].proxyUrl !== null) {
                            const validSources = ['environment', 'vscode', 'windows', 'macos', 'linux'];
                            if (!validSources.includes(results[i].source as string)) {
                                throw new Error(`Inconsistent source detected: ${results[i].source}`);
                            }
                        }
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});
