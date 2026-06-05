import { Logger } from './Logger';
import { getSanitizer, getValidator } from './ProxyUtilityInstances';

/**
 * Validates a proxy URL.
 *
 * @param url - The proxy URL to validate
 * @returns true if the URL is valid, false otherwise
 */
export function validateProxyUrl(url: string): boolean {
    const result = getValidator().validate(url);
    if (!result.isValid && result.errors.length > 0) {
        Logger.error('Proxy URL validation failed:', result.errors.join(', '));
    }
    return result.isValid;
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
