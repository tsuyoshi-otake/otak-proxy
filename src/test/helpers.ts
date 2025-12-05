/**
 * Test helper utilities for property-based and unit tests
 */

/**
 * Checks if a string contains any shell metacharacters
 * @param str - String to check
 * @returns true if string contains shell metacharacters
 */
export function containsShellMetacharacters(str: string): boolean {
    const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
    return shellMetachars.some(char => str.includes(char));
}

/**
 * Extracts password from a proxy URL if present
 * @param url - Proxy URL
 * @returns password string or null if not found
 */
export function extractPassword(url: string): string | null {
    try {
        const urlObj = new URL(url);
        return urlObj.password || null;
    } catch {
        // Try manual parsing for malformed URLs
        const match = url.match(/:([^@]+)@/);
        return match ? match[1] : null;
    }
}

/**
 * Checks if a string is masked (contains asterisks)
 * @param str - String to check
 * @returns true if string contains masking asterisks
 */
export function isMasked(str: string): boolean {
    return str.includes('***') || str.includes('****');
}

/**
 * Validates port number range
 * @param port - Port number to validate
 * @returns true if port is in valid range (1-65535)
 */
export function isValidPort(port: number): boolean {
    return port >= 1 && port <= 65535;
}

/**
 * Checks if hostname contains only valid characters
 * @param hostname - Hostname to validate
 * @returns true if hostname contains only alphanumeric, dots, hyphens
 */
export function hasValidHostnameCharacters(hostname: string): boolean {
    return /^[a-zA-Z0-9.-]+$/.test(hostname);
}

/**
 * Checks if credentials contain only valid characters
 * @param credential - Username or password to validate
 * @returns true if credential contains only alphanumeric, hyphens, underscores
 */
export function hasValidCredentialCharacters(credential: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(credential);
}

/**
 * Creates a mock validation result
 * @param isValid - Whether validation passed
 * @param errors - Array of error messages
 * @returns ValidationResult object
 */
export function createValidationResult(isValid: boolean, errors: string[] = []): { isValid: boolean; errors: string[] } {
    return { isValid, errors };
}

/**
 * Delays execution for testing async operations
 * @param ms - Milliseconds to delay
 * @returns Promise that resolves after delay
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks if a URL has a valid protocol
 * @param url - URL to check
 * @returns true if URL starts with http:// or https://
 */
export function hasValidProtocol(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Extracts hostname from URL string
 * @param url - URL string
 * @returns hostname or null if extraction fails
 */
export function extractHostname(url: string): string | null {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    } catch {
        return null;
    }
}

/**
 * Extracts port from URL string
 * @param url - URL string
 * @returns port number or null if not present
 */
export function extractPort(url: string): number | null {
    try {
        const urlObj = new URL(url);
        return urlObj.port ? parseInt(urlObj.port, 10) : null;
    } catch {
        return null;
    }
}
