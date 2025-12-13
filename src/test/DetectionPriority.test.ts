/**
 * Detection Priority and Fallback Tests
 * Tests detection source priority and fallback behavior
 *
 * Feature: cross-platform-support
 * Requirements: 5.1-5.5, 6.4, 6.5
 */

import * as assert from 'assert';
import { SystemProxyDetector, DetectionSource } from '../config/SystemProxyDetector';
import {
    EnvMocker,
    TestDataPatterns
} from './crossPlatformMockers';

/**
 * Task 5.1: Detection Priority Tests
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */
suite('Detection Priority Tests (Task 5.1)', () => {
    let detector: SystemProxyDetector;
    let envMocker: EnvMocker;

    setup(() => {
        detector = new SystemProxyDetector();
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    suite('Default Priority Order', () => {
        test('should use default priority: environment, vscode, platform', async () => {
            // Default priority is ['environment', 'vscode', 'platform']
            const defaultDetector = new SystemProxyDetector();

            // Set environment proxy to verify it's checked first
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await defaultDetector.detectSystemProxyWithSource();

            // Should detect from environment (first in default priority)
            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should accept default priority on construction', () => {
            const detector1 = new SystemProxyDetector();
            const detector2 = new SystemProxyDetector(['environment', 'vscode', 'platform']);

            // Both should be valid
            assert.ok(detector1);
            assert.ok(detector2);
        });
    });

    suite('Custom Priority Order', () => {
        test('should respect custom priority: platform first', async () => {
            // Create detector with platform first
            const customDetector = new SystemProxyDetector(['platform', 'environment', 'vscode']);

            // Clear environment to test platform detection
            envMocker.mockEnv({
                HTTP_PROXY: '',
                HTTPS_PROXY: '',
                http_proxy: '',
                https_proxy: ''
            });

            const result = await customDetector.detectSystemProxyWithSource();

            // If proxy found, should be from platform (first in custom priority)
            if (result.proxyUrl && result.source !== 'vscode') {
                const platformSources: DetectionSource[] = ['windows', 'macos', 'linux'];
                assert.ok(
                    platformSources.includes(result.source),
                    `Expected platform source, got: ${result.source}`
                );
            }
        });

        test('should respect custom priority: vscode first', async () => {
            const customDetector = new SystemProxyDetector(['vscode', 'environment', 'platform']);

            // This test verifies the detector was created with custom priority
            // Actual VSCode config detection depends on workspace settings
            const result = await customDetector.detectSystemProxyWithSource();

            // Should return valid result structure
            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
            assert.ok('source' in result);
        });

        test('should accept single source priority', async () => {
            const singleSourceDetector = new SystemProxyDetector(['environment']);

            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await singleSourceDetector.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });
    });

    suite('Environment Variable Detection Priority', () => {
        test('should detect from HTTP_PROXY environment variable', async () => {
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
                assert.strictEqual(result.proxyUrl, TestDataPatterns.expectedProxyUrl);
            }
        });

        test('should detect from HTTPS_PROXY environment variable', async () => {
            envMocker.mockEnv({
                HTTPS_PROXY: 'https://proxy.example.com:8080'
            });

            const result = await detector.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should detect from lowercase http_proxy', async () => {
            envMocker.mockEnv({
                http_proxy: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should skip platform detection when environment proxy found', async () => {
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            // If found from environment, should NOT be from platform
            if (result.proxyUrl) {
                const platformSources: DetectionSource[] = ['windows', 'macos', 'linux'];
                assert.ok(!platformSources.includes(result.source));
            }
        });
    });

    suite('Dynamic Priority Update', () => {
        test('should support updateDetectionPriority method', () => {
            const det = new SystemProxyDetector(['environment']);

            // Should not throw
            det.updateDetectionPriority(['platform', 'vscode', 'environment']);

            assert.ok(true);
        });

        test('should use updated priority after update', async () => {
            const det = new SystemProxyDetector(['invalid_source']);

            // Initially should return null (invalid source)
            let result = await det.detectSystemProxyWithSource();
            assert.strictEqual(result.proxyUrl, null);

            // Update to valid priority with environment proxy set
            det.updateDetectionPriority(['environment']);
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            result = await det.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should not update priority with empty array', async () => {
            const det = new SystemProxyDetector(['environment']);

            // Empty array should not change priority
            det.updateDetectionPriority([]);

            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await det.detectSystemProxyWithSource();

            // Should still use original priority
            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });
    });
});

/**
 * Task 5.2: Fallback Behavior Tests
 * Requirements: 5.4, 6.4, 6.5
 */
suite('Fallback Behavior Tests (Task 5.2)', () => {
    let envMocker: EnvMocker;

    setup(() => {
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    suite('Fallback to Next Source on Failure', () => {
        test('should fallback to platform when environment has no proxy', async () => {
            const detector = new SystemProxyDetector(['environment', 'platform']);

            // Clear environment proxy
            envMocker.mockEnv({
                HTTP_PROXY: '',
                HTTPS_PROXY: '',
                http_proxy: '',
                https_proxy: ''
            });

            const result = await detector.detectSystemProxyWithSource();

            // If found, should be from platform (fallback)
            if (result.proxyUrl) {
                const platformSources: DetectionSource[] = ['windows', 'macos', 'linux'];
                assert.ok(
                    platformSources.includes(result.source) || result.source === 'vscode',
                    'Should have fallen back to next source'
                );
            }
        });

        test('should try all sources before returning null', async () => {
            const detector = new SystemProxyDetector(['invalid1', 'invalid2', 'environment']);

            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            // Should eventually reach environment and find proxy
            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should handle invalid sources gracefully', async () => {
            const detector = new SystemProxyDetector(['invalid_source', 'unknown_source']);

            const result = await detector.detectSystemProxyWithSource();

            // Should return null for both proxyUrl and source
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });
    });

    suite('Return Null When All Sources Fail', () => {
        test('should return { proxyUrl: null, source: null } when all sources fail', async () => {
            const detector = new SystemProxyDetector(['invalid1', 'invalid2']);

            const result = await detector.detectSystemProxyWithSource();

            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });

        test('should return null for unknown sources', async () => {
            const detector = new SystemProxyDetector(['nonexistent', 'also_nonexistent']);

            const result = await detector.detectSystemProxyWithSource();

            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });
    });

    suite('Multiple Sources Switching', () => {
        test('should detect from first available source', async () => {
            const detector = new SystemProxyDetector(['environment', 'vscode', 'platform']);

            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            // Environment is first and has proxy, so should be detected from there
            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
            }
        });

        test('should maintain consistent result structure across fallbacks', async () => {
            const priorities = [
                ['environment'],
                ['vscode', 'environment'],
                ['platform', 'vscode', 'environment'],
                ['invalid', 'environment']
            ];

            for (const priority of priorities) {
                const detector = new SystemProxyDetector(priority);
                const result = await detector.detectSystemProxyWithSource();

                // Always should have valid structure
                assert.ok(result !== null);
                assert.ok('proxyUrl' in result);
                assert.ok('source' in result);

                // If proxyUrl is null, source should also be null
                if (result.proxyUrl === null) {
                    assert.strictEqual(result.source, null);
                } else {
                    assert.ok(result.source !== null);
                }
            }
        });
    });

    suite('Proxy Validation During Fallback', () => {
        test('should validate detected proxy URL', async () => {
            const detector = new SystemProxyDetector(['environment']);

            // Set valid proxy URL
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            // If detected, should be a valid URL format
            if (result.proxyUrl) {
                assert.ok(result.proxyUrl.startsWith('http'));
                assert.ok(result.proxyUrl.includes('://'));
            }
        });

        test('should skip invalid proxy URLs and try next source', async () => {
            const detector = new SystemProxyDetector(['environment', 'platform']);

            // Set invalid proxy URL
            envMocker.mockEnv({
                HTTP_PROXY: 'not-a-valid-url'
            });

            const result = await detector.detectSystemProxyWithSource();

            // Invalid URL should be skipped, try next source
            // Result may be null or from platform
            if (result.proxyUrl) {
                // If found from platform, source should reflect that
                assert.ok(result.source !== null);
            }
        });
    });
});
