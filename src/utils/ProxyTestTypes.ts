/**
 * Shared types for proxy connection testing.
 */

/**
 * Why a canary CONNECT failed. Canary failure is not the same as
 * "the proxy endpoint is gone" — only `endpointUnreachable` means that.
 */
export type ProxyTestFailureKind =
    | 'endpointUnreachable'
    | 'authRequired'
    | 'connectRejected'
    | 'destinationForbidden'
    | 'timeout'
    | 'dns'
    | 'protocol'
    | 'unknown';

/**
 * Error details for a single test URL.
 */
export interface TestUrlError {
    url: string;
    message: string;
    failureKind?: ProxyTestFailureKind;
}

/**
 * Result of a proxy connection test.
 */
export interface TestResult {
    success: boolean;
    testUrls: string[];
    errors: TestUrlError[];
    proxyUrl?: string;
    timestamp?: number;
    duration?: number;
    failureKind?: ProxyTestFailureKind;
    proxyEndpointOk?: boolean;
    canaryHost?: string;
}

/**
 * Options for proxy connection testing.
 */
export interface TestOptions {
    timeout?: number;
    parallel?: boolean;
    testUrls?: string[];
}
