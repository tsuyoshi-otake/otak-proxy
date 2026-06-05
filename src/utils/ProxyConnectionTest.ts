import * as http from 'http';
import * as net from 'net';
import { Logger } from './Logger';
import { TestOptions, TestResult, TestUrlError } from './ProxyTestTypes';
import {
    DEFAULT_AUTO_TIMEOUT,
    DEFAULT_MANUAL_TIMEOUT,
    DEFAULT_TEST_URLS
} from './ProxyConnectionDefaults';
import {
    buildConnectRequestOptions,
    createProxyConnectRequest,
    formatConnectFailure,
    isConnectResponseSuccessful
} from './ProxyConnectRequest';

/**
 * Tests proxy connection with comprehensive error reporting.
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

    if (options?.parallel) {
        return testProxyConnectionParallel(proxyUrl, testUrls, timeout);
    }

    return testProxyConnectionSequential(proxyUrl, testUrls, timeout);
}

async function testProxyConnectionSequential(
    proxyUrl: string,
    testUrls: string[],
    timeout: number
): Promise<TestResult> {
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

        for (const testUrl of testUrls) {
            if (await testSingleProxyUrl(proxyParsed, testUrl, timeout, errors)) {
                return finalize(true);
            }
        }

        return finalize(false);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy test error:', errorMsg);
        errors.push({ url: 'Proxy test', message: errorMsg });
        return finalize(false);
    }
}

async function testSingleProxyUrl(
    proxyParsed: URL,
    testUrl: string,
    timeout: number,
    errors: TestUrlError[]
): Promise<boolean> {
    try {
        const testParsed = new URL(testUrl);
        const requestOptions = buildConnectRequestOptions(proxyParsed, testParsed, timeout);
        return await createProxyConnectionAttempt(proxyParsed, testUrl, timeout, errors, requestOptions);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ url: testUrl, message: errorMsg });
        return false;
    }
}

function createProxyConnectionAttempt(
    proxyParsed: URL,
    testUrl: string,
    timeout: number,
    errors: TestUrlError[],
    requestOptions: http.RequestOptions
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const req = createProxyConnectRequest(proxyParsed, requestOptions);
        let requestSettled = false;

        const finish = (success: boolean, error?: string) => {
            if (requestSettled) {
                return;
            }

            requestSettled = true;
            if (error) {
                errors.push({ url: testUrl, message: error });
            }
            resolve(success);
        };

        req.on('connect', (response, socket) => {
            destroySocket(socket);
            req.destroy();

            finish(
                isConnectResponseSuccessful(response),
                isConnectResponseSuccessful(response) ? undefined : formatConnectFailure(response)
            );
        });

        req.on('error', (error: Error) => {
            finish(false, error.message || 'Connection failed');
        });

        req.on('timeout', () => {
            req.destroy();
            finish(false, `Connection timeout (${timeout}ms)`);
        });

        req.end();
    });
}

function destroySocket(socket: net.Socket): void {
    try {
        socket.destroy();
    } catch {
        // Ignore destroy errors
    }
}

/**
 * Get default test URLs.
 */
export function getDefaultTestUrls(): string[] {
    return [...DEFAULT_TEST_URLS];
}

/**
 * Get default manual test timeout.
 */
export function getDefaultManualTimeout(): number {
    return DEFAULT_MANUAL_TIMEOUT;
}

/**
 * Get default auto test timeout.
 */
export function getDefaultAutoTimeout(): number {
    return DEFAULT_AUTO_TIMEOUT;
}

/**
 * Tests proxy connection in parallel with multiple test URLs.
 * Uses Promise.race() to complete as soon as any URL succeeds.
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

                    const req = createProxyConnectRequest(proxyParsed, requestOptions);
                    requests.push(req);

                    req.on('connect', (response, socket) => {
                        try {
                            socket.destroy();
                            req.destroy();
                        } catch {
                            // Ignore destroy errors
                        }

                        if (isConnectResponseSuccessful(response)) {
                            onTestResult(testUrl, true);
                        } else {
                            onTestResult(testUrl, false, formatConnectFailure(response));
                        }
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
                errors.push({ url: 'All tests', message: `Overall timeout (${timeout}ms)` });
                resolve(done({
                    success: false,
                    proxyUrl,
                    testUrls,
                    errors
                }));
            }, timeout + 500);
        });

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
