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
 * Validates a proxy URL and returns its canonical form (#108). Entry points
 * that bring a URL into the system store and apply this value.
 *
 * @param url - The proxy URL to validate
 * @returns The canonical URL, or undefined when invalid
 */
export function canonicalizeValidProxyUrl(url: string): string | undefined {
    const result = getValidator().validate(url);
    if (!result.isValid) {
        if (result.errors.length > 0) {
            Logger.error('Proxy URL validation failed:', result.errors.join(', '));
        }
        return undefined;
    }
    return result.normalizedUrl;
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
