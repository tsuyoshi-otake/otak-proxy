import { Logger } from './Logger';
import { getSanitizer, getValidator } from './ProxyUtilityInstances';

/**
 * Validates a proxy URL.
 *
 * @param url - The proxy URL to validate
 * @returns true if the URL is valid, false otherwise
 */
export function validateProxyUrl(url: string): boolean {
    return canonicalizeValidProxyUrl(url) !== undefined;
}

/**
 * Validates a proxy URL and returns its canonical form without logging
 * (#108). For read paths that run on every state load — an invalid value is
 * ignored quietly because activation reports it once.
 *
 * @param url - The proxy URL to validate
 * @returns The canonical URL, or undefined when invalid
 */
export function tryCanonicalizeProxyUrl(url: string): string | undefined {
    const result = getValidator().validate(url);
    return result.isValid ? result.normalizedUrl : undefined;
}

/**
 * Validates a proxy URL and returns its canonical form (#108). Entry points
 * that bring a URL into the system store and apply this value.
 *
 * @param url - The proxy URL to validate
 * @returns The canonical URL, or undefined when invalid
 */
export function canonicalizeValidProxyUrl(url: string): string | undefined {
    const canonical = tryCanonicalizeProxyUrl(url);
    if (canonical !== undefined) {
        return canonical;
    }
    const { errors } = getValidator().validate(url);
    if (errors.length > 0) {
        Logger.error('Proxy URL validation failed:', errors.join(', '));
    }
    return undefined;
}

/**
 * Sanitizes a proxy URL by masking credentials.
 *
 * @param url - The proxy URL to sanitize
 * @returns The sanitized URL with password masked
 */
export function sanitizeProxyUrl(url: string): string {
    if (!url) {
        return '';
    }
    return getSanitizer().maskPassword(url);
}
