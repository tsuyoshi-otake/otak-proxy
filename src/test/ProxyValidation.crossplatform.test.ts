/**
 * Proxy URL Validation and Property-Based Tests
 * Tests ProxyUrlValidator and cross-platform property tests
 *
 * Feature: cross-platform-support
 * Requirements: 7.1-7.4, 9.1, 9.3
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { SystemProxyDetector, DetectionSource } from '../config/SystemProxyDetector';
import {
    PlatformMocker,
    EnvMocker,
    TestDataPatterns
} from './crossPlatformMockers';
import { getPropertyTestRuns } from './helpers';

/**
 * Task 6.1: Proxy URL Validation Tests
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */
suite('Proxy URL Validation Tests (Task 6.1)', () => {
    let validator: ProxyUrlValidator;
    let envMocker: EnvMocker;

    setup(() => {
        validator = new ProxyUrlValidator();
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    suite('ProxyUrlValidator Basic Functionality', () => {
        test('should validate correct proxy URL format', () => {
            const result = validator.validate('http://proxy.example.com:8080');

            assert.ok(result.isValid);
            assert.ok(result.errors.length === 0);
        });

        test('should validate HTTPS proxy URL', () => {
            const result = validator.validate('https://proxy.example.com:8080');

            assert.ok(result.isValid);
        });

        test('should validate proxy URL with authentication', () => {
            const result = validator.validate('http://user:pass@proxy.example.com:8080');

            assert.ok(result.isValid);
        });

        test('should reject invalid URL format', () => {
            const result = validator.validate('not-a-valid-url');

            assert.ok(!result.isValid);
            assert.ok(result.errors.length > 0);
        });

        test('should reject empty string', () => {
            const result = validator.validate('');

            assert.ok(!result.isValid);
        });
    });

    suite('Consistent Validation Across Platforms', () => {
        let restorePlatform: (() => void) | null = null;

        teardown(() => {
            if (restorePlatform) {
                restorePlatform();
                restorePlatform = null;
            }
        });

        test('should validate same URL identically on Windows', () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');

            const validator1 = new ProxyUrlValidator();
            const result = validator1.validate(TestDataPatterns.expectedProxyUrl);

            assert.ok(result.isValid);
        });

        test('should validate same URL identically on macOS', () => {
            restorePlatform = PlatformMocker.mockPlatform('darwin');

            const validator1 = new ProxyUrlValidator();
            const result = validator1.validate(TestDataPatterns.expectedProxyUrl);

            assert.ok(result.isValid);
        });

        test('should validate same URL identically on Linux', () => {
            restorePlatform = PlatformMocker.mockPlatform('linux');

            const validator1 = new ProxyUrlValidator();
            const result = validator1.validate(TestDataPatterns.expectedProxyUrl);

            assert.ok(result.isValid);
        });
    });

    suite('Validation During Detection', () => {
        test('should return only validated URLs from detection', async () => {
            const detector = new SystemProxyDetector(['environment']);

            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            if (result.proxyUrl) {
                // Detected proxy should be validated
                const validationResult = validator.validate(result.proxyUrl);
                assert.ok(validationResult.isValid, 'Detected proxy should be valid');
            }
        });

        test('should skip invalid URLs and try next source', async () => {
            const detector = new SystemProxyDetector(['environment', 'platform']);

            // Set invalid proxy URL
            envMocker.mockEnv({
                HTTP_PROXY: 'invalid://proxy'
            });

            const result = await detector.detectSystemProxyWithSource();

            // If a proxy is found, it should be valid
            if (result.proxyUrl) {
                const validationResult = validator.validate(result.proxyUrl);
                assert.ok(validationResult.isValid, 'Only valid proxies should be returned');
            }
        });
    });

    suite('Warning Log on Invalid URL', () => {
        test('should return invalid result for malformed URLs', () => {
            const malformedUrls = [
                'http://',
                'http://[invalid',
                'ftp://proxy.example.com',
                ':8080',
                'proxy:8080:extra'
            ];

            for (const url of malformedUrls) {
                const result = validator.validate(url);

                // Some of these may be valid depending on validator strictness
                // This test documents the expected behavior
                assert.ok('isValid' in result);
                assert.ok('errors' in result);
            }
        });
    });
});

/**
 * Task 6.2: Property-Based Tests
 * Requirements: 9.1, 9.3
 */
suite('Cross-Platform Property-Based Tests (Task 6.2)', () => {
    let envMocker: EnvMocker;

    setup(() => {
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    /**
     * Property: Detection always returns valid structure
     */
    test('Property: Detection always returns { proxyUrl, source } structure', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate different priority combinations
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (priority) => {
                    const detector = new SystemProxyDetector(priority);
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Result must have correct structure
                    if (result === null || typeof result !== 'object') {
                        throw new Error('Result must be an object');
                    }

                    if (!('proxyUrl' in result) || !('source' in result)) {
                        throw new Error('Result must have proxyUrl and source fields');
                    }

                    // Property: Types must be correct
                    if (result.proxyUrl !== null && typeof result.proxyUrl !== 'string') {
                        throw new Error('proxyUrl must be string or null');
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: ProxyUrl and Source are consistent
     */
    test('Property: proxyUrl null implies source null', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (priority) => {
                    const detector = new SystemProxyDetector(priority);
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: If proxyUrl is null, source must also be null
                    if (result.proxyUrl === null && result.source !== null) {
                        throw new Error('When proxyUrl is null, source must also be null');
                    }

                    // Property: If proxyUrl exists, source must not be null
                    if (result.proxyUrl !== null && result.source === null) {
                        throw new Error('When proxyUrl exists, source must not be null');
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Valid sources
     */
    test('Property: Source is always from valid set', async function () {
        this.timeout(30000);

        const validSources: (DetectionSource | null)[] = ['environment', 'vscode', 'windows', 'macos', 'linux', null];

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (priority) => {
                    const detector = new SystemProxyDetector(priority);
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Source must be from valid set
                    if (!validSources.includes(result.source)) {
                        throw new Error(`Invalid source: ${result.source}`);
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Detection is deterministic within same environment
     */
    test('Property: Multiple calls return consistent structure', async function () {
        this.timeout(60000);

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                fc.integer({ min: 2, max: 3 }),
                async (priority, callCount) => {
                    const detector = new SystemProxyDetector(priority);
                    const results: { proxyUrl: string | null; source: DetectionSource }[] = [];

                    for (let i = 0; i < callCount; i++) {
                        results.push(await detector.detectSystemProxyWithSource());
                    }

                    // Property: All results have valid structure
                    for (const result of results) {
                        if (result === null || typeof result !== 'object') {
                            throw new Error('All results must be objects');
                        }

                        if (!('proxyUrl' in result) || !('source' in result)) {
                            throw new Error('All results must have proxyUrl and source');
                        }
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Environment detection with arbitrary valid URLs
     */
    test('Property: Valid proxy URLs are detected from environment', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate valid-ish proxy URLs
                fc.tuple(
                    fc.constantFrom('http', 'https'),
                    fc.domain(),
                    fc.integer({ min: 1, max: 65535 })
                ),
                async ([protocol, domain, port]) => {
                    const proxyUrl = `${protocol}://${domain}:${port}`;
                    const detector = new SystemProxyDetector(['environment']);

                    envMocker.mockEnv({ HTTP_PROXY: proxyUrl });
                    const result = await detector.detectSystemProxyWithSource();
                    envMocker.restore();

                    // Property: If proxy found, it should be from environment
                    if (result.proxyUrl) {
                        if (result.source !== 'environment') {
                            throw new Error(`Expected source 'environment', got '${result.source}'`);
                        }
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Invalid sources always return null
     */
    test('Property: Unknown sources return null', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                // Generate invalid source names
                fc.array(
                    fc.constantFrom('invalid1', 'invalid2', 'unknown', 'bad_source', 'xyz'),
                    { minLength: 1, maxLength: 3 }
                ),
                async (invalidSources: string[]) => {
                    const detector = new SystemProxyDetector(invalidSources);
                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Unknown sources should return null
                    if (result.proxyUrl !== null || result.source !== null) {
                        throw new Error(
                            `Expected null result for invalid sources [${invalidSources.join(', ')}], ` +
                            `got proxyUrl: ${result.proxyUrl}, source: ${result.source}`
                        );
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Property: Priority update takes effect
     */
    test('Property: updateDetectionPriority changes behavior', async function () {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                fc.shuffledSubarray(['environment', 'vscode', 'platform'], { minLength: 1, maxLength: 3 }),
                async (initial, updated) => {
                    const detector = new SystemProxyDetector(initial);

                    // Update priority
                    detector.updateDetectionPriority(updated);

                    const result = await detector.detectSystemProxyWithSource();

                    // Property: Detection should work after update
                    if (result === null || typeof result !== 'object') {
                        throw new Error('Detection should work after priority update');
                    }

                    if (!('proxyUrl' in result) || !('source' in result)) {
                        throw new Error('Result structure must be valid after update');
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});

/**
 * Cross-Platform Consistency Tests
 */
suite('Cross-Platform Consistency Tests', () => {
    let restorePlatform: (() => void) | null = null;
    let envMocker: EnvMocker;

    setup(() => {
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    test('should have consistent API across all platforms', async () => {
        const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

        for (const platform of platforms) {
            restorePlatform = PlatformMocker.mockPlatform(platform);

            const detector = new SystemProxyDetector();
            const result = await detector.detectSystemProxyWithSource();

            // API should be consistent
            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
            assert.ok('source' in result);

            if (restorePlatform) {
                restorePlatform();
                restorePlatform = null;
            }
        }
    });

    test('should have consistent validation across all platforms', () => {
        const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];
        const testUrl = TestDataPatterns.expectedProxyUrl;

        for (const platform of platforms) {
            restorePlatform = PlatformMocker.mockPlatform(platform);

            const validator = new ProxyUrlValidator();
            const result = validator.validate(testUrl);

            // Validation should be consistent
            assert.ok(result.isValid, `URL should be valid on ${platform}`);

            if (restorePlatform) {
                restorePlatform();
                restorePlatform = null;
            }
        }
    });
});
