/**
 * @file utils/ProxyUtils.ts Unit Tests
 * @description Tests for utility functions exported from utils/ProxyUtils.ts
 * Validates Requirements 6.1, 6.2
 */

import * as assert from 'assert';
import * as sinon from 'sinon';

suite('ProxyUtils Test Suite', () => {
    let proxyUtils: typeof import('../../utils/ProxyUtils');
    let sandbox: sinon.SinonSandbox;

    suiteSetup(() => {
        proxyUtils = require('../../utils/ProxyUtils');
        sandbox = sinon.createSandbox();
    });

    suiteTeardown(() => {
        sandbox.restore();
    });

    suite('validateProxyUrl', () => {
        test('should export validateProxyUrl function', () => {
            assert.ok(typeof proxyUtils.validateProxyUrl === 'function',
                'validateProxyUrl should be exported as a function');
        });

        test('should return true for valid http URL', () => {
            const result = proxyUtils.validateProxyUrl('http://proxy.example.com:8080');
            assert.strictEqual(result, true, 'Valid http URL should return true');
        });

        test('should return true for valid https URL', () => {
            const result = proxyUtils.validateProxyUrl('https://proxy.example.com:443');
            assert.strictEqual(result, true, 'Valid https URL should return true');
        });

        test('should return false for invalid URL', () => {
            const result = proxyUtils.validateProxyUrl('not-a-url');
            assert.strictEqual(result, false, 'Invalid URL should return false');
        });

        test('should return false for empty URL', () => {
            const result = proxyUtils.validateProxyUrl('');
            assert.strictEqual(result, false, 'Empty URL should return false');
        });

        test('should return false for URL with shell metacharacters', () => {
            const result = proxyUtils.validateProxyUrl('http://proxy.com;rm -rf /');
            assert.strictEqual(result, false, 'URL with shell metacharacters should return false');
        });
    });

    suite('sanitizeProxyUrl', () => {
        test('should export sanitizeProxyUrl function', () => {
            assert.ok(typeof proxyUtils.sanitizeProxyUrl === 'function',
                'sanitizeProxyUrl should be exported as a function');
        });

        test('should mask password in URL with credentials', () => {
            const result = proxyUtils.sanitizeProxyUrl('http://user:password@proxy.example.com:8080');
            assert.ok(result.includes('***'), 'Password should be masked');
            assert.ok(!result.includes('password'), 'Original password should not be visible');
        });

        test('should not modify URL without credentials', () => {
            const url = 'http://proxy.example.com:8080';
            const result = proxyUtils.sanitizeProxyUrl(url);
            // Note: URL normalization may add trailing slash
            assert.ok(result.includes('proxy.example.com:8080'),
                'URL without credentials should remain unchanged (except normalization)');
        });

        test('should handle empty string', () => {
            const result = proxyUtils.sanitizeProxyUrl('');
            assert.strictEqual(result, '', 'Empty string should return empty string');
        });
    });

    suite('TestResult interface', () => {
        test('TestResult type should be properly structured', () => {
            // Create a mock test result to verify the interface
            const testResult: import('../../utils/ProxyUtils').TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: []
            };

            assert.strictEqual(testResult.success, true);
            assert.ok(Array.isArray(testResult.testUrls));
            assert.ok(Array.isArray(testResult.errors));
        });

        test('TestResult should include error details on failure', () => {
            const testResult: import('../../utils/ProxyUtils').TestResult = {
                success: false,
                testUrls: ['https://example.com'],
                errors: [{ url: 'https://example.com', message: 'Connection failed' }]
            };

            assert.strictEqual(testResult.success, false);
            assert.strictEqual(testResult.errors.length, 1);
            assert.strictEqual(testResult.errors[0].url, 'https://example.com');
        });
    });

    suite('testProxyConnection', () => {
        test('should export testProxyConnection function', () => {
            assert.ok(typeof proxyUtils.testProxyConnection === 'function',
                'testProxyConnection should be exported as a function');
        });

        test('should return TestResult object', async function() {
            // Increase timeout for network connection tests
            this.timeout(20000);

            // This test validates the return type structure
            // The actual connection test may fail, which is expected
            const result = await proxyUtils.testProxyConnection('http://invalid-proxy:9999');

            assert.ok(typeof result.success === 'boolean', 'result.success should be boolean');
            assert.ok(Array.isArray(result.testUrls), 'result.testUrls should be array');
            assert.ok(Array.isArray(result.errors), 'result.errors should be array');
        });

        test('should include test URLs in result', async function() {
            // Increase timeout for network connection tests
            this.timeout(20000);

            const result = await proxyUtils.testProxyConnection('http://proxy:8080');

            assert.ok(result.testUrls.length > 0, 'Should include test URLs');
            assert.ok(result.testUrls.every(url => url.startsWith('https://')),
                'Test URLs should be HTTPS');
        });
    });

    suite('detectSystemProxySettings', () => {
        test('should export detectSystemProxySettings function', () => {
            assert.ok(typeof proxyUtils.detectSystemProxySettings === 'function',
                'detectSystemProxySettings should be exported as a function');
        });

        test('should return string or null', async () => {
            const result = await proxyUtils.detectSystemProxySettings();

            assert.ok(result === null || typeof result === 'string',
                'Result should be null or string');
        });
    });

    suite('Module exports', () => {
        test('should export all required functions', () => {
            const requiredExports = [
                'validateProxyUrl',
                'sanitizeProxyUrl',
                'testProxyConnection',
                'detectSystemProxySettings'
            ];

            for (const exportName of requiredExports) {
                assert.ok(exportName in proxyUtils,
                    `${exportName} should be exported from ProxyUtils`);
            }
        });
    });
});
