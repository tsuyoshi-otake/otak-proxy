/**
 * Test configuration helpers
 */

/**
 * Get the number of runs for property-based tests based on environment
 * @returns Number of test runs (100 for CI, 5 for development)
 */
export function getPropertyTestRuns(): number {
    const raw = process.env.OTAK_PROXY_PROPERTY_RUNS;
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    // Developer ergonomics: allow a very fast mode for iterative work.
    // CI keeps using the larger default.
    if (process.env.OTAK_PROXY_TEST_FAST) {
        return 1;
    }

    return process.env.CI ? 100 : 5;
}

/**
 * Get timeout for property-based tests based on environment
 * @param baseTimeout Base timeout in milliseconds
 * @returns Adjusted timeout (10x for CI, 1x for development)
 */
export function getPropertyTestTimeout(baseTimeout: number): number {
    const raw = process.env.OTAK_PROXY_TEST_TIMEOUT_MULTIPLIER;
    if (raw) {
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.floor(baseTimeout * parsed);
        }
    }

    if (process.env.OTAK_PROXY_TEST_FAST) {
        return baseTimeout;
    }

    return process.env.CI ? baseTimeout * 10 : baseTimeout;
}
