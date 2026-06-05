/**
 * Shared types for proxy connection testing.
 */

/**
 * Error details for a single test URL.
 */
export interface TestUrlError {
    url: string;
    message: string;
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
}

/**
 * Options for proxy connection testing.
 */
export interface TestOptions {
    timeout?: number;
    parallel?: boolean;
    testUrls?: string[];
}
