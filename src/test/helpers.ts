/**
 * Test configuration helpers
 */

/**
 * Get the number of runs for property-based tests based on environment
 * @returns Number of test runs (100 for CI, 5 for development)
 */
export function getPropertyTestRuns(): number {
    return process.env.CI ? 100 : 5;
}

/**
 * Get timeout for property-based tests based on environment
 * @param baseTimeout Base timeout in milliseconds
 * @returns Adjusted timeout (10x for CI, 1x for development)
 */
export function getPropertyTestTimeout(baseTimeout: number): number {
    return process.env.CI ? baseTimeout * 10 : baseTimeout;
}
