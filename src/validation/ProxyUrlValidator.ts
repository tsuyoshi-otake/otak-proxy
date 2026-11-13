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
    /** The canonical form the URL was validated as (#108). Present when valid. */
    normalizedUrl?: string;
}

/**
 * Brings a proxy URL into its one canonical form without changing what is
 * accepted (#108):
 * - surrounding ASCII spaces are trimmed and the scheme is lowercased
 *   (control characters, tab/CR/LF included, are rejected by the validator and
 *   never trimmed);
 * - a path that is exactly `/` (no query, no fragment) is dropped — any other
 *   path, query or fragment is left in place and stays invalid;
 * - in the userinfo, a `%` not followed by two hex digits is a literal `%` and
 *   is written as `%25`, so the credential decode cannot throw on it.
 *
 * For every URL accepted without canonicalization, the result equals the
 * input except for the scheme's letter case.
 */
export function canonicalizeProxyUrl(url: string): string {
    const trimmed = url.replace(/^ +| +$/g, '');
    const schemeMatch = /^(https?):\/\//i.exec(trimmed);
    if (!schemeMatch) {
        return trimmed;
    }

    const scheme = `${schemeMatch[1].toLowerCase()}://`;
    let rest = trimmed.substring(schemeMatch[0].length);

    const at = rest.lastIndexOf('@');
    if (at > 0) {
        const userinfo = rest.slice(0, at).replace(/%(?![0-9a-fA-F]{2})/g, '%25');
        rest = userinfo + rest.slice(at);
    }

    if (rest.endsWith('/') && !/[/?#\s\\]/.test(rest.slice(0, -1))) {
        rest = rest.slice(0, -1);
    }

    return scheme + rest;
}

/**
 * True when the text holds a C0 control character or DEL (#130).
 *
 * The WHATWG URL parser strips C0 controls from both ends of its input and
 * removes tab, LF and CR everywhere, so with one of them present the parser
 * reads a different string than the checks before it: a leading tab hid the
 * scheme from the authority check, and a backslash login passed as a path with
 * its password. No proxy URL needs these characters, so they are rejected
 * wherever they stand instead of being normalized away.
 */
function containsControlCharacter(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
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
        // Validate the canonical form so that every caller accepts the same
        // set of real-world URLs (#108). The canonical URL is handed back on
        // success so entry points can store and apply it unchanged.
        const canonical = canonicalizeProxyUrl(url);

        const requiredError = this.validateRequiredUrl(canonical);
        if (requiredError) {
            return { isValid: false, errors: [requiredError] };
        }

        const securityError = this.validateSecurity(canonical);
        if (securityError) {
            return { isValid: false, errors: [securityError] };
        }

        if (containsControlCharacter(canonical)) {
            return { isValid: false, errors: ['Proxy URL contains control characters'] };
        }

        const preParseError = this.validateProxyAuthoritySyntax(canonical);
        if (preParseError) {
            return { isValid: false, errors: [preParseError] };
        }

        const parsed = this.parseUrl(canonical);
        if (parsed instanceof Error) {
            return { isValid: false, errors: ['Invalid URL format'] };
        }

        const errors = this.validateParsedUrl(parsed, canonical);

        return {
            isValid: errors.length === 0,
            errors,
            normalizedUrl: errors.length === 0 ? canonical : undefined
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
