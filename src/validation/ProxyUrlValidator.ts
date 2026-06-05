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
    private static readonly INVALID_HOSTNAME_ERROR = 'Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)';

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
        const requiredError = this.validateRequiredUrl(url);
        if (requiredError) {
            return { isValid: false, errors: [requiredError] };
        }

        const securityError = this.validateSecurity(url);
        if (securityError) {
            return { isValid: false, errors: [securityError] };
        }

        const preParseError = this.validateProxyAuthoritySyntax(url);
        if (preParseError) {
            return { isValid: false, errors: [preParseError] };
        }

        const parsed = this.parseUrl(url);
        if (parsed instanceof Error) {
            return { isValid: false, errors: ['Invalid URL format'] };
        }

        const errors = this.validateParsedUrl(parsed);

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    private validateRequiredUrl(url: string): string | null {
        return !url || url.trim().length === 0
            ? 'Proxy URL cannot be empty'
            : null;
    }

    private validateSecurity(url: string): string | null {
        return this.containsShellMetacharacters(url)
            ? 'Proxy URL contains dangerous shell metacharacters'
            : null;
    }

    private validateProxyAuthoritySyntax(url: string): string | null {
        const protocolMatch = url.match(/^(https?):\/\//);
        if (!protocolMatch) {
            return null;
        }

        const afterProtocol = url.substring(protocolMatch[0].length);
        return this.isProxyAuthoritySyntaxValid(afterProtocol)
            ? null
            : ProxyUrlValidator.INVALID_HOSTNAME_ERROR;
    }

    private isProxyAuthoritySyntaxValid(authority: string): boolean {
        const invalidChars = /[/?#\s\\]/;
        if (invalidChars.test(authority)) {
            return false;
        }

        const parts = authority.split('@');
        if (parts.length > 2) {
            return false;
        }

        const hostPortPart = parts[parts.length - 1];
        return /^[a-zA-Z0-9.\-:]+$/.test(hostPortPart);
    }

    private parseUrl(url: string): URL | Error {
        try {
            return new URL(url);
        } catch (error) {
            return error instanceof Error ? error : new Error('Invalid URL format');
        }
    }

    private validateParsedUrl(parsed: URL): string[] {
        const errors: string[] = [];
        this.validateProtocol(parsed, errors);
        this.validateHostname(parsed, errors);
        this.validatePort(parsed, errors);
        return this.validateCredentials(parsed, errors);
    }

    private validateProtocol(parsed: URL, errors: string[]): void {
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            errors.push('Protocol must be http:// or https://');
        }
    }

    private validateHostname(parsed: URL, errors: string[]): void {
        if (!parsed.hostname || parsed.hostname.length === 0) {
            errors.push('Hostname is required');
            return;
        }

        if (!ProxyUrlValidator.HOSTNAME_PATTERN.test(parsed.hostname)) {
            errors.push(ProxyUrlValidator.INVALID_HOSTNAME_ERROR);
        }
    }

    private validatePort(parsed: URL, errors: string[]): void {
        if (!parsed.port) {
            return;
        }

        const port = parseInt(parsed.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            errors.push('Port must be between 1 and 65535');
        }
    }

    private validateCredentials(parsed: URL, errors: string[]): string[] {
        if (!parsed.username && !parsed.password) {
            return errors;
        }

        let decodedUsername = '';
        let decodedPassword = '';
        try {
            decodedUsername = parsed.username ? decodeURIComponent(parsed.username) : '';
            decodedPassword = parsed.password ? decodeURIComponent(parsed.password) : '';
        } catch {
            errors.push('Invalid URL format');
            return errors;
        }

        if (decodedUsername && !ProxyUrlValidator.CREDENTIAL_PATTERN.test(decodedUsername)) {
            errors.push('Username contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)');
        }

        if (decodedPassword && !ProxyUrlValidator.CREDENTIAL_PATTERN.test(decodedPassword)) {
            errors.push('Password contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)');
        }

        return errors;
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
