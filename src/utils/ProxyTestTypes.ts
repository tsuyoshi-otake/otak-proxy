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
    /**
     * Generation captured when the test started. Completions without this
     * still fence on URL identity, but A→B→A requires the stamp.
     */
    startedGeneration?: import('../core/LogicalGeneration').LogicalGeneration;
    failureKind?: ProxyTestFailureKind;
    proxyEndpointOk?: boolean;
    /**
     * At least one attempt opened a TCP connection to the proxy itself. A
     * timeout after that point is the canary or the proxy's upstream, not a
     * dead endpoint (#97).
     */
    proxyConnected?: boolean;
    canaryHost?: string;
    /**
     * Set by the monitor when the check that ran this test reports
     * proxyChanged after it; that event carries this result (#102).
     */
    proxyChange?: ReportedProxyChange;
}

/**
 * The proxyChanged event a monitor check reports after its connection test
 * and reachability events, as those events see it (#102).
 */
export interface ReportedProxyChange {
    /** The generation the check started from: the fence proxyChanged applies. */
    startedGeneration: import('../core/LogicalGeneration').LogicalGeneration;
    /** The detected per-scheme/bypass routing, as detectionSplitRoutingIdentity() spells it. */
    routing: string;
}

/**
 * Options for proxy connection testing.
 */
export interface TestOptions {
    timeout?: number;
    parallel?: boolean;
    testUrls?: string[];
}
