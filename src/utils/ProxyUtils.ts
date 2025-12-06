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

/**
 * Tests proxy connection with comprehensive error reporting
 *
 * @param proxyUrl - The proxy URL to test
 * @returns Object with success status and test details
 */
export async function testProxyConnection(proxyUrl: string): Promise<TestResult> {
    const errors: TestUrlError[] = [];
    const testUrls = [
        'https://www.github.com',
        'https://www.microsoft.com',
        'https://www.google.com'
    ];

    try {
        const http = require('http');
        const url = require('url');

        const proxyParsed = url.parse(proxyUrl);

        // Test connection through proxy for each URL
        for (const testUrl of testUrls) {
            try {
                const testParsed = url.parse(testUrl);
                const options = {
                    host: proxyParsed.hostname,
                    port: proxyParsed.port || 8080,
                    method: 'CONNECT',
                    path: `${testParsed.hostname}:443`,
                    timeout: 5000
                };

                const result = await new Promise<boolean>((resolve) => {
                    const req = http.request(options);

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
                        errors.push({ url: testUrl, message: 'Connection timeout (5 seconds)' });
                        req.destroy();
                        resolve(false);
                    });

                    req.end();
                });

                if (result) {
                    // At least one test URL worked - success
                    return { success: true, testUrls, errors };
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                errors.push({ url: testUrl, message: errorMsg });
                continue; // Try next URL
            }
        }

        // All test URLs failed
        return { success: false, testUrls, errors };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy test error:', errorMsg);
        errors.push({ url: 'Proxy test', message: errorMsg });
        return { success: false, testUrls, errors };
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
