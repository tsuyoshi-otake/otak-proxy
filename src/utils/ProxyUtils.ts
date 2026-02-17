/**
 * @file Proxy Utility Functions
 * @description Common utility functions for proxy URL validation, sanitization, testing, and detection
 *
 * This module provides shared utility functions used across the extension.
 * Extracting these to a dedicated module improves:
 * - Code reusability (Requirement 6.1)
 * - Consistent validation and sanitization (Requirement 6.2)
 */

import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { UserNotifier } from '../errors/UserNotifier';
import { Logger } from './Logger';
import * as vscode from 'vscode';
import * as http from 'http';

// Module-level instances (initialized lazily)
let validator: ProxyUrlValidator | null = null;
let sanitizer: InputSanitizer | null = null;
let systemProxyDetector: SystemProxyDetector | null = null;
let userNotifier: UserNotifier | null = null;

/**
 * Get or create the ProxyUrlValidator instance
 */
function getValidator(): ProxyUrlValidator {
    if (!validator) {
        validator = new ProxyUrlValidator();
    }
    return validator;
}

/**
 * Get or create the InputSanitizer instance
 */
function getSanitizer(): InputSanitizer {
    if (!sanitizer) {
        sanitizer = new InputSanitizer();
    }
    return sanitizer;
}

/**
 * Get or create the SystemProxyDetector instance
 */
function getSystemProxyDetector(): SystemProxyDetector {
    if (!systemProxyDetector) {
        const config = vscode.workspace.getConfiguration('otakProxy');
        const detectionSourcePriority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
        systemProxyDetector = new SystemProxyDetector(detectionSourcePriority);
    }
    return systemProxyDetector;
}

/**
 * Get or create the UserNotifier instance
 */
function getUserNotifier(): UserNotifier {
    if (!userNotifier) {
        userNotifier = new UserNotifier();
    }
    return userNotifier;
}

/**
 * Error details for a single test URL
 */
export interface TestUrlError {
    url: string;
    message: string;
}

/**
 * Result of a proxy connection test
 */
export interface TestResult {
    success: boolean;
    testUrls: string[];
    errors: TestUrlError[];
    proxyUrl?: string;
    timestamp?: number;
    duration?: number;
}

/**
 * Options for proxy connection testing
 */
export interface TestOptions {
    timeout?: number;
    parallel?: boolean;
    testUrls?: string[];
}

/**
 * Validates a proxy URL
 *
 * @param url - The proxy URL to validate
 * @returns true if the URL is valid, false otherwise
 */
export function validateProxyUrl(url: string): boolean {
    const result = getValidator().validate(url);
    if (!result.isValid && result.errors.length > 0) {
        Logger.error('Proxy URL validation failed:', result.errors.join(', '));
    }
    return result.isValid;
}

/**
 * Sanitizes a proxy URL by masking credentials
 *
 * @param url - The proxy URL to sanitize
 * @returns The sanitized URL with password masked
 */
export function sanitizeProxyUrl(url: string): string {
    if (!url) {
        return '';
    }
    // Use InputSanitizer class for consistent credential masking
    return getSanitizer().maskPassword(url);
}

/** Default test URLs for proxy connection testing */
const DEFAULT_TEST_URLS = [
    'https://www.github.com',
    'https://www.microsoft.com',
    'https://www.google.com'
];

/** Default timeout for manual tests (5 seconds) */
const DEFAULT_MANUAL_TIMEOUT = 5000;

/** Default timeout for auto tests (3 seconds) */
const DEFAULT_AUTO_TIMEOUT = 3000;

/** Default port when proxy URL doesn't specify one */
const DEFAULT_PROXY_PORT = 8080;

/** Default target port for CONNECT tests (HTTPS) */
const DEFAULT_TARGET_PORT = 443;

function parsePort(port: string, fallback: number): number {
    const parsed = Number(port);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildConnectRequestOptions(proxy: URL, target: URL, timeout: number): http.RequestOptions {
    return {
        hostname: proxy.hostname,
        port: parsePort(proxy.port, DEFAULT_PROXY_PORT),
        method: 'CONNECT',
        path: `${target.hostname}:${parsePort(target.port, DEFAULT_TARGET_PORT)}`,
        timeout
    };
}

/**
 * Tests proxy connection with comprehensive error reporting
 *
 * @param proxyUrl - The proxy URL to test
 * @param options - Optional test configuration
 * @returns Object with success status and test details
 */
export async function testProxyConnection(
    proxyUrl: string,
    options?: TestOptions
): Promise<TestResult> {
    const timeout = options?.timeout ?? DEFAULT_MANUAL_TIMEOUT;
    const testUrls = options?.testUrls ?? DEFAULT_TEST_URLS;

    // If parallel mode is requested, use the parallel implementation
    if (options?.parallel) {
        return testProxyConnectionParallel(proxyUrl, testUrls, timeout);
    }

    // Sequential mode (original behavior)
    const errors: TestUrlError[] = [];
    const startTime = Date.now();

    const finalize = (success: boolean): TestResult => ({
        success,
        testUrls,
        errors,
        proxyUrl,
        timestamp: Date.now(),
        duration: Date.now() - startTime
    });

    try {
        const proxyParsed = new URL(proxyUrl);

        // Test connection through proxy for each URL sequentially
        for (const testUrl of testUrls) {
            try {
                const testParsed = new URL(testUrl);
                const requestOptions = buildConnectRequestOptions(proxyParsed, testParsed, timeout);

                const isConnected = await new Promise<boolean>((resolve) => {
                    const req = http.request(requestOptions);

                    req.on('connect', () => {
                        resolve(true);
                        req.destroy();
                    });

                    req.on('error', (error: Error) => {
                        // Collect error for this test URL
                        errors.push({ url: testUrl, message: error.message || 'Connection failed' });
                        resolve(false);
                    });

                    req.on('timeout', () => {
                        // Collect timeout error for this test URL
                        errors.push({ url: testUrl, message: `Connection timeout (${timeout}ms)` });
                        req.destroy();
                        resolve(false);
                    });

                    req.end();
                });

                if (isConnected) {
                    // At least one test URL worked - success
                    return finalize(true);
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                errors.push({ url: testUrl, message: errorMsg });
            }
        }

        // All test URLs failed
        return finalize(false);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy test error:', errorMsg);
        errors.push({ url: 'Proxy test', message: errorMsg });
        return finalize(false);
    }
}

/**
 * Get default test URLs
 */
export function getDefaultTestUrls(): string[] {
    return [...DEFAULT_TEST_URLS];
}

/**
 * Get default manual test timeout
 */
export function getDefaultManualTimeout(): number {
    return DEFAULT_MANUAL_TIMEOUT;
}

/**
 * Get default auto test timeout
 */
export function getDefaultAutoTimeout(): number {
    return DEFAULT_AUTO_TIMEOUT;
}

/**
 * Tests proxy connection in parallel with multiple test URLs
 * Uses Promise.race() to complete as soon as any URL succeeds
 *
 * @param proxyUrl - The proxy URL to test
 * @param testUrls - Array of URLs to test through the proxy
 * @param timeout - Timeout in milliseconds for each test
 * @returns Object with success status and test details including proxyUrl, timestamp, and duration
 */
export async function testProxyConnectionParallel(
    proxyUrl: string,
    testUrls: string[],
    timeout: number
): Promise<TestResult> {
    const startTime = Date.now();
    const errors: TestUrlError[] = [];

    try {
        const proxyParsed = new URL(proxyUrl);

        const requests: http.ClientRequest[] = [];
        let settled = false;
        let completedCount = 0;
        let overallTimer: ReturnType<typeof setTimeout> | null = null;

        const finalize = (result: Omit<TestResult, 'timestamp' | 'duration'>): TestResult => ({
            ...result,
            errors: [...result.errors],
            timestamp: Date.now(),
            duration: Date.now() - startTime
        });

        const destroyOutstanding = () => {
            for (const req of requests) {
                try {
                    req.destroy();
                } catch {
                    // Ignore destroy errors
                }
            }
        };

        const done = (result: Omit<TestResult, 'timestamp' | 'duration'>): TestResult => {
            if (settled) {
                return finalize(result);
            }
            settled = true;
            if (overallTimer) {
                clearTimeout(overallTimer);
                overallTimer = null;
            }
            destroyOutstanding();
            return finalize(result);
        };

        // Execute all tests in parallel and stop the rest as soon as any succeeds.
        const successPromise = new Promise<TestResult>((resolve) => {
            const totalTests = testUrls.length;

            const resolveIfAllDone = () => {
                if (completedCount === totalTests && !settled) {
                    resolve(done({
                        success: false,
                        proxyUrl,
                        testUrls,
                        errors
                    }));
                }
            };

            const onTestResult = (testUrl: string, success: boolean, error?: string) => {
                if (settled) {
                    return;
                }

                completedCount++;

                if (success) {
                    resolve(done({
                        success: true,
                        proxyUrl,
                        testUrls,
                        errors
                    }));
                    return;
                }

                if (error) {
                    errors.push({ url: testUrl, message: error });
                }

                resolveIfAllDone();
            };

            for (const testUrl of testUrls) {
                try {
                    const testParsed = new URL(testUrl);
                    const requestOptions = buildConnectRequestOptions(proxyParsed, testParsed, timeout);

                    const req = http.request(requestOptions);
                    requests.push(req);

                    req.on('connect', () => {
                        try {
                            req.destroy();
                        } catch {
                            // Ignore destroy errors
                        }
                        onTestResult(testUrl, true);
                    });

                    req.on('error', (error: Error) => {
                        onTestResult(testUrl, false, error.message || 'Connection failed');
                    });

                    req.on('timeout', () => {
                        try {
                            req.destroy();
                        } catch {
                            // Ignore destroy errors
                        }
                        onTestResult(testUrl, false, `Connection timeout (${timeout}ms)`);
                    });

                    req.end();
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                    onTestResult(testUrl, false, errorMsg);
                }
            }
        });

        const timeoutPromise = new Promise<TestResult>((resolve) => {
            overallTimer = setTimeout(() => {
                if (settled) {
                    return;
                }
                // Overall timeout: destroy outstanding requests and return what we know so far.
                errors.push({ url: 'All tests', message: `Overall timeout (${timeout}ms)` });
                resolve(done({
                    success: false,
                    proxyUrl,
                    testUrls,
                    errors
                }));
            }, timeout + 500); // Buffer to allow per-request timeouts to fire first.
        });

        // Race between early success/all-complete and overall timeout.
        return await Promise.race([successPromise, timeoutPromise]);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy parallel test error:', errorMsg);
        errors.push({ url: 'Proxy test', message: errorMsg });
        return {
            success: false,
            proxyUrl,
            testUrls,
            errors,
            timestamp: Date.now(),
            duration: Date.now() - startTime
        };
    }
}

/**
 * Detects system proxy settings
 *
 * @returns The detected proxy URL or null if not found/invalid
 */
export async function detectSystemProxySettings(): Promise<string | null> {
    const detector = getSystemProxyDetector();
    const notifier = getUserNotifier();
    const urlValidator = getValidator();
    const urlSanitizer = getSanitizer();

    try {
        const detectedProxy = await detector.detectSystemProxy();

        if (!detectedProxy) {
            Logger.log('No system proxy detected');
            return null;
        }

        // Validate detected proxy before returning
        const validationResult = urlValidator.validate(detectedProxy);
        if (!validationResult.isValid) {
            Logger.warn('Detected system proxy has invalid format:', detectedProxy);
            Logger.warn('Validation errors:', validationResult.errors.join(', '));

            notifier.showWarning(
                `Detected system proxy has invalid format: ${urlSanitizer.maskPassword(detectedProxy)}`
            );

            return null;
        }

        // Return validated proxy
        return detectedProxy;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('System proxy detection failed:', errorMsg);

        notifier.showWarning('System proxy detection failed. You can configure a proxy manually.');

        return null;
    }
}

/**
 * Updates the detection priority for system proxy detection
 *
 * @param priority - Array of detection sources in priority order
 */
export function updateDetectionPriority(priority: string[]): void {
    const detector = getSystemProxyDetector();
    detector.updateDetectionPriority(priority);
}

/**
 * Resets module-level instances (useful for testing)
 */
export function resetInstances(): void {
    validator = null;
    sanitizer = null;
    systemProxyDetector = null;
    userNotifier = null;
}
