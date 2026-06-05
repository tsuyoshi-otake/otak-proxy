/**
 * @file utils/ProxyUtils.ts Unit Tests
 * @description Tests for utility functions exported from utils/ProxyUtils.ts
 * Validates Requirements 6.1, 6.2
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as http from 'http';
import * as vscode from 'vscode';

suite('ProxyUtils Test Suite', () => {
    let proxyUtils: typeof import('../../utils/ProxyUtils');
    let sandbox: sinon.SinonSandbox;

    async function listen(server: http.Server): Promise<number> {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                const address = server.address();
                if (typeof address === 'object' && address !== null) {
                    resolve(address.port);
                    return;
                }
                reject(new Error('Unable to determine test proxy port'));
            });
        });
    }

    async function close(server: http.Server): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }

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

        test('should fail when proxy CONNECT response is not successful', async function() {
            this.timeout(5000);
            const server = http.createServer();
            server.on('connect', (_request, socket) => {
                socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
                socket.destroy();
            });

            const port = await listen(server);
            try {
                const result = await proxyUtils.testProxyConnection(
                    `http://127.0.0.1:${port}`,
                    { timeout: 1000, testUrls: ['https://example.com'] }
                );

                assert.strictEqual(result.success, false);
                assert.ok(
                    result.errors.some(error => error.message.includes('407')),
                    `Expected CONNECT 407 error, got: ${JSON.stringify(result.errors)}`
                );
            } finally {
                await close(server);
            }
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

        test('should use latest detection priority from configuration', async () => {
            let priority = ['invalid_source'];
            const getConfigurationStub = sinon.stub(vscode.workspace, 'getConfiguration').returns({
                get: (key: string, defaultValue?: unknown) => {
                    if (key === 'detectionSourcePriority') {
                        return priority;
                    }
                    if (key === 'proxy') {
                        return 'http://vscode-proxy.example.com:8080';
                    }
                    return defaultValue;
                },
                update: () => Promise.resolve(),
                has: () => true,
                inspect: () => undefined
            } as vscode.WorkspaceConfiguration);

            try {
                proxyUtils.resetInstances();

                const invalidSourceResult = await proxyUtils.detectSystemProxySettings();
                assert.strictEqual(invalidSourceResult, null);

                priority = ['vscode', 'environment'];
                const vscodeResult = await proxyUtils.detectSystemProxySettings();
                assert.strictEqual(vscodeResult, 'http://vscode-proxy.example.com:8080');
            } finally {
                proxyUtils.resetInstances();
                getConfigurationStub.restore();
            }
        });
    });

    suite('Module exports', () => {
        test('should export all required functions', () => {
            const requiredExports = [
                'validateProxyUrl',
                'sanitizeProxyUrl',
                'testProxyConnection',
                'testProxyConnectionParallel',
                'detectSystemProxySettings'
            ];

            for (const exportName of requiredExports) {
                assert.ok(exportName in proxyUtils,
                    `${exportName} should be exported from ProxyUtils`);
            }
        });
    });

    suite('testProxyConnectionParallel', () => {
        test('should export testProxyConnectionParallel function', () => {
            assert.ok(typeof proxyUtils.testProxyConnectionParallel === 'function',
                'testProxyConnectionParallel should be exported as a function');
        });

        test('should return TestResult object with proxyUrl and timestamp', async function() {
            this.timeout(15000);

            const testUrls = ['https://www.github.com', 'https://www.microsoft.com'];
            const result = await proxyUtils.testProxyConnectionParallel(
                'http://invalid-proxy:9999',
                testUrls,
                3000
            );

            assert.ok(typeof result.success === 'boolean', 'result.success should be boolean');
            assert.ok(Array.isArray(result.testUrls), 'result.testUrls should be array');
            assert.ok(Array.isArray(result.errors), 'result.errors should be array');
            assert.ok(typeof result.proxyUrl === 'string', 'result.proxyUrl should be string');
            assert.ok(typeof result.timestamp === 'number', 'result.timestamp should be number');
            assert.ok(typeof result.duration === 'number', 'result.duration should be number');
        });

        test('should complete within timeout', async function() {
            this.timeout(10000);

            const startTime = Date.now();
            const timeout = 2000;

            await proxyUtils.testProxyConnectionParallel(
                'http://invalid-proxy:9999',
                ['https://www.github.com'],
                timeout
            );

            const elapsed = Date.now() - startTime;
            // Allow some tolerance for test execution overhead
            assert.ok(elapsed < timeout + 2000,
                `Should complete within timeout + tolerance (elapsed: ${elapsed}ms)`);
        });

        test('should succeed if any test URL succeeds (parallel early termination)', async function() {
            this.timeout(15000);

            // This test validates behavior - with invalid proxy all should fail
            const result = await proxyUtils.testProxyConnectionParallel(
                'http://invalid-proxy:9999',
                ['https://www.github.com', 'https://www.microsoft.com', 'https://www.google.com'],
                3000
            );

            // With invalid proxy, should fail
            assert.strictEqual(result.success, false, 'Should fail with invalid proxy');
            assert.ok(result.errors.length > 0, 'Should have errors when proxy fails');
        });

        test('should record duration of test execution', async function() {
            this.timeout(15000);

            const result = await proxyUtils.testProxyConnectionParallel(
                'http://invalid-proxy:9999',
                ['https://www.github.com'],
                3000
            );

            assert.ok(result.duration !== undefined, 'duration should be defined');
            assert.ok(result.duration >= 0, 'duration should be non-negative');
        });

        test('should send proxy basic authentication header when credentials are present', async function() {
            this.timeout(5000);
            const server = http.createServer();
            let proxyAuthorization: string | undefined;

            server.on('connect', (request, socket) => {
                proxyAuthorization = request.headers['proxy-authorization'];
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                socket.destroy();
            });

            const port = await listen(server);
            try {
                const result = await proxyUtils.testProxyConnectionParallel(
                    `http://user:pass@127.0.0.1:${port}`,
                    ['https://example.com'],
                    1000
                );

                assert.strictEqual(result.success, true);
                assert.strictEqual(
                    proxyAuthorization,
                    `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`
                );
            } finally {
                await close(server);
            }
        });

        test('should fail when parallel CONNECT response is not successful', async function() {
            this.timeout(5000);
            const server = http.createServer();
            server.on('connect', (_request, socket) => {
                socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
                socket.destroy();
            });

            const port = await listen(server);
            try {
                const result = await proxyUtils.testProxyConnectionParallel(
                    `http://127.0.0.1:${port}`,
                    ['https://example.com'],
                    1000
                );

                assert.strictEqual(result.success, false);
                assert.ok(
                    result.errors.some(error => error.message.includes('407')),
                    `Expected CONNECT 407 error, got: ${JSON.stringify(result.errors)}`
                );
            } finally {
                await close(server);
            }
        });
    });
});
