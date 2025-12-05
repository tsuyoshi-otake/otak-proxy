/**
 * Validation interfaces and types
 */
export interface ValidationError {
    field: 'protocol' | 'hostname' | 'port' | 'credentials' | 'security';
    message: string;
    suggestion?: string;
}

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

/**
 * ProxyUrlValidator class for comprehensive proxy URL validation
 * 
 * Validates proxy URLs for format correctness and security, preventing
 * command injection through strict character whitelisting.
 */
export class ProxyUrlValidator {
    // Shell metacharacters that could be used for command injection
    private static readonly SHELL_METACHARACTERS = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
    
    // Allowed characters for hostname (alphanumeric, dots, hyphens)
    private static readonly HOSTNAME_PATTERN = /^[a-zA-Z0-9.-]+$/;
    
    // Allowed characters for credentials (alphanumeric, hyphens, underscores, @)
    private static readonly CREDENTIAL_PATTERN = /^[a-zA-Z0-9\-_@]+$/;

    /**
     * Validates a proxy URL for format and security
     * @param url - The proxy URL to validate
     * @returns ValidationResult with success status and error details
     */
    validate(url: string): ValidationResult {
        const errors: string[] = [];

        // Check for empty or whitespace-only URLs
        if (!url || url.trim().length === 0) {
            errors.push('Proxy URL cannot be empty');
            return { isValid: false, errors };
        }

        // Check for shell metacharacters first (security check)
        if (this.containsShellMetacharacters(url)) {
            errors.push('Proxy URL contains dangerous shell metacharacters');
            return { isValid: false, errors };
        }

        // Pre-parse validation: Proxy URLs should not contain path, query, or fragment
        // Characters like ?, #, / after the hostname:port would indicate these components
        const protocolMatch = url.match(/^(https?):\/\//);
        if (protocolMatch) {
            const afterProtocol = url.substring(protocolMatch[0].length);
            
            // Proxy URLs should only have: [username:password@]hostname[:port]
            // No path (/), query (?), or fragment (#) should be present
            // First, check for completely invalid characters
            const invalidChars = /[/?#\s\\]/;
            if (invalidChars.test(afterProtocol)) {
                errors.push('Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)');
                return { isValid: false, errors };
            }
            
            // Check @ symbol usage: should appear at most once, separating credentials from hostname
            const atCount = (afterProtocol.match(/@/g) || []).length;
            if (atCount > 1) {
                errors.push('Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)');
                return { isValid: false, errors };
            }
            
            // If @ is present, validate the hostname part (after @)
            if (atCount === 1) {
                const parts = afterProtocol.split('@');
                const hostPortPart = parts[1];
                
                // Hostname part should only contain: alphanumeric, dots, hyphens, colons (for port)
                const validHostPortPattern = /^[a-zA-Z0-9.\-:]+$/;
                if (!validHostPortPattern.test(hostPortPart)) {
                    errors.push('Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)');
                    return { isValid: false, errors };
                }
            } else {
                // No credentials, entire string should be hostname:port
                const validHostPortPattern = /^[a-zA-Z0-9.\-:]+$/;
                if (!validHostPortPattern.test(afterProtocol)) {
                    errors.push('Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)');
                    return { isValid: false, errors };
                }
            }
        }

        // Parse URL
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch (error) {
            errors.push('Invalid URL format');
            return { isValid: false, errors };
        }

        // Validate protocol
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push('Protocol must be http:// or https://');
        }

        // Validate hostname
        if (!parsed.hostname || parsed.hostname.length === 0) {
            errors.push('Hostname is required');
        } else if (!ProxyUrlValidator.HOSTNAME_PATTERN.test(parsed.hostname)) {
            errors.push('Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)');
        }

        // Validate port if present
        if (parsed.port) {
            const port = parseInt(parsed.port, 10);
            if (isNaN(port) || port < 1 || port > 65535) {
                errors.push('Port must be between 1 and 65535');
            }
        }

        // Validate credentials if present
        if (parsed.username || parsed.password) {
            // Decode URL-encoded credentials for validation
            const decodedUsername = parsed.username ? decodeURIComponent(parsed.username) : '';
            const decodedPassword = parsed.password ? decodeURIComponent(parsed.password) : '';
            
            if (decodedUsername && !ProxyUrlValidator.CREDENTIAL_PATTERN.test(decodedUsername)) {
                errors.push('Username contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)');
            }
            if (decodedPassword && !ProxyUrlValidator.CREDENTIAL_PATTERN.test(decodedPassword)) {
                errors.push('Password contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)');
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Checks if URL contains shell metacharacters
     * @param url - The URL to check
     * @returns true if URL contains dangerous characters
     */
    containsShellMetacharacters(url: string): boolean {
        return ProxyUrlValidator.SHELL_METACHARACTERS.some(char => url.includes(char));
    }
}
