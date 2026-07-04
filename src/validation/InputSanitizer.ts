/**
 * InputSanitizer - Sanitizes proxy URLs for safe display in logs, UI, and error messages
 *
 * This class ensures that sensitive credentials (passwords) are never exposed in:
 * - Log files
 * - UI elements (status bar, notifications)
 * - Error messages
 * - Any other display contexts
 *
 * Redaction overlap (#16): this is the URL-shaped, username-preserving masker for
 * the Logger/UI hot path — it emits `user:****@host` from a single proxy URL. The
 * broader, stricter masker for arbitrary diagnostics/remediation text is
 * {@link ../security/ProxySecretRedactor.ProxySecretRedactor}, which fully masks
 * credentials (`<credentials>@`) plus headers, tokens, and known secrets. The two
 * are deliberately separate (different placeholders and username policy); if you
 * change credential-masking behavior here, mirror it there so they cannot drift.
 * Unifying them is tracked as follow-up work, not done inline, because this masker
 * feeds ~two dozen UI/log call sites whose output format would otherwise change.
 */
export class InputSanitizer {
    /**
     * Masks password in proxy URL for display
     * Replaces the password portion with asterisks while preserving URL structure
     * 
     * @param url - The proxy URL with potential credentials
     * @returns URL with password replaced by asterisks (****)
     * 
     * Examples:
     * - "http://user:pass@proxy.com:8080" -> "http://user:****@proxy.com:8080"
     * - "http://proxy.com:8080" -> "http://proxy.com:8080" (no change)
     * - "invalid-url" -> "invalid-url" (returns as-is for malformed URLs)
     */
    maskPassword(url: string): string {
        try {
            const parsed = new URL(url);

            // If there's a password, mask it
            if (parsed.password) {
                parsed.password = '****';
                return parsed.toString();
            }

            if (parsed.username || parsed.host) {
                return parsed.toString();
            }

            // Scheme-less "user:secret@host" parses as an opaque URL ("user:" is
            // taken as the scheme, the rest as the path) with no host and no
            // credentials — fall through to the regex fallbacks below.
        } catch {
            // Fall through to the regex fallbacks.
        }

        // URL parsing failed or found no authority; try to mask credentials with
        // regexes so malformed or scheme-less values still get masked.
        // Look for pattern: //username:password@ or ://username:password@
        const credentialPattern = /(\/\/[^:@]+):([^@]+)@/;
        if (credentialPattern.test(url)) {
            // Replace the password (everything after : and before @)
            // Keep the username part (match[1] includes //username)
            return url.replace(credentialPattern, '$1:****@');
        }

        // Scheme-less "user:password@host" (e.g. raw git/npm config values).
        const bareCredentialPattern = /(^|[\s=])([^\s@:/]+):([^\s@/]+)@/g;
        if (bareCredentialPattern.test(url)) {
            return url.replace(bareCredentialPattern, '$1$2:****@');
        }

        // If no credentials found, return the original URL
        return url;
    }

    /**
     * Removes credentials entirely from URL
     * Strips both username and password from the URL
     * 
     * @param url - The proxy URL
     * @returns URL without username:password portion
     * 
     * Examples:
     * - "http://user:pass@proxy.com:8080" -> "http://proxy.com:8080"
     * - "http://proxy.com:8080" -> "http://proxy.com:8080" (no change)
     * - "invalid-url" -> "invalid-url" (returns as-is for malformed URLs)
     */
    removeCredentials(url: string): string {
        try {
            const parsed = new URL(url);
            
            // Remove both username and password
            parsed.username = '';
            parsed.password = '';
            
            return parsed.toString();
        } catch {
            // If URL parsing fails, try to remove credentials using regex
            // Pattern: protocol://username:password@host or protocol://username@host
            const credentialPattern = /\/\/[^@]+@/;
            
            if (credentialPattern.test(url)) {
                // Remove everything between // and @
                return url.replace(/\/\/[^@]+@/, '//');
            }
            
            // If no credentials found, return the original URL
            return url;
        }
    }
}
