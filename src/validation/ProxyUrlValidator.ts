import {
    classifyProxyHostname,
    describeInvalidProxyAuthority
} from './ProxyHost';

/**
 * Validation interfaces and types
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
}

/**
 * ProxyUrlValidator class for comprehensive proxy URL validation
 * 
 * Validates proxy URLs for format correctness and security. Credentials may
 * contain WHATWG-encodable reserved characters; only shell metacharacters are
 * rejected after decode so command argv semantics cannot change.
 */
export class ProxyUrlValidator {
    // Shell metacharacters that could be used for command injection
    private static readonly SHELL_METACHARACTERS = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];

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

        const errors = this.validateParsedUrl(parsed, url);

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
        return describeInvalidProxyAuthority(afterProtocol);
    }

    private parseUrl(url: string): URL | Error {
        try {
            return new URL(url);
        } catch (error) {
            return error instanceof Error ? error : new Error('Invalid URL format');
        }
    }

    private validateParsedUrl(parsed: URL, originalUrl: string): string[] {
        const errors: string[] = [];
        this.validateProtocol(parsed, errors);
        this.validateHostname(parsed, errors);
        this.validatePort(parsed, errors);
        return this.validateCredentials(parsed, originalUrl, errors);
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

        const classified = classifyProxyHostname(parsed.hostname);
        if (!classified.ok) {
            errors.push(classified.error);
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

    private extractRawUserinfo(url: string): { username: string; password: string } | null {
        const protocolMatch = url.match(/^(https?):\/\//);
        if (!protocolMatch) {
            return null;
        }

        const afterProtocol = url.substring(protocolMatch[0].length);
        const at = afterProtocol.lastIndexOf('@');
        if (at <= 0) {
            return null;
        }

        const userinfo = afterProtocol.slice(0, at);
        const colon = userinfo.indexOf(':');
        if (colon === -1) {
            return { username: userinfo, password: '' };
        }

        return {
            username: userinfo.slice(0, colon),
            password: userinfo.slice(colon + 1)
        };
    }

    private validateCredentials(parsed: URL, originalUrl: string, errors: string[]): string[] {
        if (!parsed.username && !parsed.password) {
            return errors;
        }

        const raw = this.extractRawUserinfo(originalUrl);
        let decodedUsername = parsed.username;
        let decodedPassword = parsed.password;
        if (raw) {
            try {
                decodedUsername = raw.username ? decodeURIComponent(raw.username) : '';
                decodedPassword = raw.password ? decodeURIComponent(raw.password) : '';
            } catch {
                errors.push('Invalid URL format');
                return errors;
            }
        }

        if (decodedUsername && this.containsShellMetacharacters(decodedUsername)) {
            errors.push('Username contains dangerous shell characters');
        }

        if (decodedPassword && this.containsShellMetacharacters(decodedPassword)) {
            errors.push('Password contains dangerous shell characters');
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
