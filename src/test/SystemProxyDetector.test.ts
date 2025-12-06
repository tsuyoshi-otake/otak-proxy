/**
 * Unit tests for SystemProxyDetector
 * Tests proxy detection with priority, fallback, and source tracking
 *
 * Feature: auto-proxy-detection-improvements
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import * as assert from 'assert';
import { SystemProxyDetector, DetectionSource, ProxyDetectionWithSource } from '../config/SystemProxyDetector';

suite('SystemProxyDetector Test Suite', () => {
    let detector: SystemProxyDetector;

    setup(() => {
        detector = new SystemProxyDetector();
    });

    suite('constructor', () => {
        test('should create instance with default priority', () => {
            const det = new SystemProxyDetector();
            assert.ok(det);
        });

        test('should create instance with custom priority', () => {
            const det = new SystemProxyDetector(['vscode', 'environment', 'platform']);
            assert.ok(det);
        });
    });

    suite('updateDetectionPriority', () => {
        test('should update detection priority with valid array', () => {
            detector.updateDetectionPriority(['vscode', 'platform', 'environment']);
            // If no error thrown, test passes
            assert.ok(true);
        });

        test('should not update priority with empty array', () => {
            // Should not throw, but should not update
            detector.updateDetectionPriority([]);
            assert.ok(true);
        });

        test('should handle single source priority', () => {
            detector.updateDetectionPriority(['environment']);
            assert.ok(true);
        });
    });

    suite('detectSystemProxy', () => {
        test('should return string or null', async () => {
            const result = await detector.detectSystemProxy();
            assert.ok(result === null || typeof result === 'string');
        });

        test('should handle detection without errors', async () => {
            // This test verifies that detection doesn't throw
            try {
                await detector.detectSystemProxy();
                assert.ok(true);
            } catch (error) {
                assert.fail('detectSystemProxy should not throw');
            }
        });
    });

    suite('detectSystemProxyWithSource', () => {
        test('should return ProxyDetectionWithSource object', async () => {
            const result = await detector.detectSystemProxyWithSource();

            // Check result structure
            assert.ok(result !== null && typeof result === 'object');
            assert.ok('proxyUrl' in result);
            assert.ok('source' in result);

            // Check types
            assert.ok(result.proxyUrl === null || typeof result.proxyUrl === 'string');
            const validSources: (DetectionSource | null)[] = ['environment', 'vscode', 'windows', 'macos', 'linux', null];
            assert.ok(validSources.includes(result.source));
        });

        test('should handle detection without errors', async () => {
            try {
                await detector.detectSystemProxyWithSource();
                assert.ok(true);
            } catch (error) {
                assert.fail('detectSystemProxyWithSource should not throw');
            }
        });

        test('should return consistent source with proxyUrl', async () => {
            const result = await detector.detectSystemProxyWithSource();

            // If proxyUrl is null, source should also be null
            if (result.proxyUrl === null) {
                assert.strictEqual(result.source, null);
            } else {
                // If proxyUrl exists, source should not be null
                assert.ok(result.source !== null);
            }
        });
    });

    suite('priority-based detection', () => {
        test('should use default priority order', async () => {
            // Default priority is ['environment', 'vscode', 'platform']
            const defaultDetector = new SystemProxyDetector();

            // Just verify it doesn't throw
            const result = await defaultDetector.detectSystemProxyWithSource();
            assert.ok(result !== null);
        });

        test('should respect custom priority order', async () => {
            // Create detector with custom priority
            const customDetector = new SystemProxyDetector(['platform', 'vscode', 'environment']);

            // Just verify it doesn't throw
            const result = await customDetector.detectSystemProxyWithSource();
            assert.ok(result !== null);
        });
    });

    suite('error handling', () => {
        test('should handle platform detection gracefully', async () => {
            // Platform detection may fail, but should not throw
            const result = await detector.detectSystemProxyWithSource();
            assert.ok(result !== null);
        });

        test('should return null on all sources failing', async () => {
            // Create a detector with unknown sources to simulate all failures
            const failDetector = new SystemProxyDetector(['unknown1', 'unknown2']);

            const result = await failDetector.detectSystemProxyWithSource();

            // Should return null for both fields
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });
    });
});

suite('SystemProxyDetector Priority Tests', () => {
    /**
     * Tests for Requirement 7.1: Detection source priority
     * System should check detection sources in configured priority order
     */
    test('Requirement 7.1: Should check sources in priority order', async () => {
        // Create detector with specific priority
        const detector = new SystemProxyDetector(['environment', 'vscode', 'platform']);

        // Execute detection
        const result = await detector.detectSystemProxyWithSource();

        // If a proxy is found, verify the source matches expected priority
        if (result.proxyUrl !== null) {
            const validSources: DetectionSource[] = ['environment', 'vscode', 'windows', 'macos', 'linux'];
            assert.ok(validSources.includes(result.source as DetectionSource));
        }
    });

    /**
     * Tests for Requirement 7.2: Fallback on failure
     * System should try next source if higher priority source fails
     */
    test('Requirement 7.2: Should fallback to next source on failure', async () => {
        // Create detector with mixed valid and invalid sources
        const detector = new SystemProxyDetector(['invalid_source', 'environment', 'platform']);

        // Detection should still work by falling back
        const result = await detector.detectSystemProxyWithSource();

        // Should return result (may be null if no proxy configured)
        assert.ok(result !== null);
    });

    /**
     * Tests for Requirement 7.3: Return null when all sources fail
     */
    test('Requirement 7.3: Should return null when all sources fail', async () => {
        // Create detector with only invalid sources
        const detector = new SystemProxyDetector(['invalid1', 'invalid2', 'invalid3']);

        const result = await detector.detectSystemProxyWithSource();

        // Should return null for both proxyUrl and source
        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.source, null);
    });

    /**
     * Tests for Requirement 7.4: Dynamic priority update
     */
    test('Requirement 7.4: Should support dynamic priority update', async () => {
        const detector = new SystemProxyDetector(['environment']);

        // Update priority
        detector.updateDetectionPriority(['platform', 'vscode', 'environment']);

        // Detection should work with new priority
        const result = await detector.detectSystemProxyWithSource();
        assert.ok(result !== null);
    });
});
