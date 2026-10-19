import { Logger } from './Logger';
import {
    classifyConnectError,
    classifyConnectStatus,
    summarizeFailedProxyTest
} from './ProxyTestFailure';
import { ProxyTestFailureKind, TestOptions, TestResult, TestUrlError } from './ProxyTestTypes';
import {
    DEFAULT_AUTO_TIMEOUT,
    DEFAULT_MANUAL_TIMEOUT,
    DEFAULT_TEST_URLS
} from './ProxyConnectionDefaults';
import {
    buildConnectRequestOptions,
    ConnectRequestOptions,
    connectThroughProxy,
    formatConnectDestination,
    formatConnectFailure,
    isConnectResponseSuccessful,
    ProxyConnectHandle
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
    let proxyConnected = false;
    const markProxyConnected = () => {
        proxyConnected = true;
    };

    const finalize = (success: boolean): TestResult => ({
        success,
        testUrls,
        errors,
        proxyUrl,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        ...(success
            ? { proxyEndpointOk: true }
            : summarizeFailedProxyTest(errors, testUrls)),
        ...(proxyConnected ? { proxyConnected: true } : {})
    });

    try {
        const proxyParsed = new URL(proxyUrl);

        for (const testUrl of testUrls) {
            if (await testSingleProxyUrl(proxyParsed, testUrl, timeout, errors, markProxyConnected)) {
                return finalize(true);
            }
        }

        return finalize(false);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy test error:', errorMsg);
        errors.push({ url: 'Proxy test', message: errorMsg, failureKind: classifyConnectError(error instanceof Error ? error : errorMsg) });
        return finalize(false);
    }
}

async function testSingleProxyUrl(
    proxyParsed: URL,
    testUrl: string,
    timeout: number,
    errors: TestUrlError[],
    onProxyConnected: () => void
): Promise<boolean> {
    try {
        const testParsed = new URL(testUrl);
        const requestOptions = buildConnectRequestOptions(proxyParsed, testParsed, timeout);
        return await createProxyConnectionAttempt(
            testUrl,
            timeout,
            errors,
            requestOptions,
            onProxyConnected
        );
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push({
            url: testUrl,
            message: errorMsg,
            failureKind: classifyConnectError(error instanceof Error ? error : errorMsg)
        });
        return false;
    }
}

function createProxyConnectionAttempt(
    testUrl: string,
    timeout: number,
    errors: TestUrlError[],
    requestOptions: ConnectRequestOptions,
    onProxyConnected: () => void
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const connection = connectThroughProxy(requestOptions, onProxyConnected);
        let requestSettled = false;

        const finish = (success: boolean, error?: string, failureKind?: ProxyTestFailureKind) => {
            if (requestSettled) {
                return;
            }

            requestSettled = true;
            if (watchdog) {
                clearTimeout(watchdog);
            }
            if (error) {
                Logger.error('Proxy CONNECT failed:', formatConnectDestination(requestOptions), error);
                errors.push({ url: testUrl, message: error, failureKind });
            }
            resolve(success);
        };

        const watchdog = setTimeout(() => {
            connection.cancel();
            finish(false, `Connection timeout (${timeout}ms)`, 'timeout');
        }, timeout);

        connection.result.then(
            response => {
                const connected = isConnectResponseSuccessful(response);
                finish(
                    connected,
                    connected ? undefined : formatConnectFailure(response),
                    connected ? undefined : classifyConnectStatus(response.statusCode)
                );
            },
            (error: Error) => {
                finish(false, error.message || 'Connection failed', classifyConnectError(error));
            }
        );
    });
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

        const connections: ProxyConnectHandle[] = [];
        let settled = false;
        let completedCount = 0;
        let overallTimer: ReturnType<typeof setTimeout> | null = null;
        let proxyConnected = false;
        const markProxyConnected = () => {
            proxyConnected = true;
        };

        const finalize = (result: Omit<TestResult, 'timestamp' | 'duration'>): TestResult => {
            const classified = result.success
                ? { proxyEndpointOk: true as const }
                : summarizeFailedProxyTest(result.errors, result.testUrls);
            return {
                ...result,
                ...classified,
                ...(proxyConnected ? { proxyConnected: true } : {}),
                errors: [...result.errors],
                timestamp: Date.now(),
                duration: Date.now() - startTime
            };
        };

        const destroyOutstanding = () => {
            for (const connection of connections) {
                connection.cancel();
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

            const onTestResult = (
                testUrl: string,
                success: boolean,
                error?: string,
                requestOptions?: ConnectRequestOptions,
                failureKind?: ProxyTestFailureKind
            ) => {
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
                    if (requestOptions) {
                        Logger.error('Proxy CONNECT failed:', formatConnectDestination(requestOptions), error);
                    } else {
                        Logger.error('Proxy CONNECT failed:', error);
                    }
                    errors.push({ url: testUrl, message: error, failureKind });
                }

                resolveIfAllDone();
            };

            for (const testUrl of testUrls) {
                try {
                    const testParsed = new URL(testUrl);
                    const requestOptions = buildConnectRequestOptions(proxyParsed, testParsed, timeout);

                    const connection = connectThroughProxy(requestOptions, markProxyConnected);
                    connections.push(connection);

                    connection.result.then(
                        response => {
                            if (isConnectResponseSuccessful(response)) {
                                onTestResult(testUrl, true);
                            } else {
                                onTestResult(
                                    testUrl,
                                    false,
                                    formatConnectFailure(response),
                                    requestOptions,
                                    classifyConnectStatus(response.statusCode)
                                );
                            }
                        },
                        (error: Error) => {
                            onTestResult(
                                testUrl,
                                false,
                                error.message || 'Connection failed',
                                requestOptions,
                                classifyConnectError(error)
                            );
                        }
                    );
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                    onTestResult(
                        testUrl,
                        false,
                        errorMsg,
                        undefined,
                        classifyConnectError(error instanceof Error ? error : errorMsg)
                    );
                }
            }
        });

        const timeoutPromise = new Promise<TestResult>((resolve) => {
            overallTimer = setTimeout(() => {
                if (settled) {
                    return;
                }
                errors.push({
                    url: 'All tests',
                    message: `Overall timeout (${timeout}ms)`,
                    failureKind: 'timeout'
                });
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
        errors.push({
            url: 'Proxy test',
            message: errorMsg,
            failureKind: classifyConnectError(error instanceof Error ? error : errorMsg)
        });
        return {
            success: false,
            proxyUrl,
            testUrls,
            errors,
            timestamp: Date.now(),
            duration: Date.now() - startTime,
            ...summarizeFailedProxyTest(errors, testUrls)
        };
    }
}
