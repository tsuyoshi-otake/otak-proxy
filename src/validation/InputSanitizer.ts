/**
 * InputSanitizer - Sanitizes proxy URLs for safe display in logs, UI, and error messages
 *
 * This class ensures that sensitive credentials (passwords) are never exposed in:
 * - Log files
 * - UI elements (status bar, notifications)
 * - Error messages
 * - Any other display contexts
 *
 * Redaction overlap (#16, #108): this is the URL-shaped masker for the
 * Logger/UI hot path. It emits `user:****@host` when a distinct password
 * exists, and masks the username itself when userinfo contains only one
 * component because that value is commonly an API token. The broader, stricter
 * masker for arbitrary diagnostics/remediation text is
 * {@link ../security/ProxySecretRedactor.ProxySecretRedactor}, which fully
 * masks credentials (`<credentials>@`) plus headers, tokens, and known
 * secrets. Both apply credentials through the shared
 * {@link ../security/ProxySecretRedactor.maskCredentialOccurrences} so they
 * find the same occurrences; only the replacement text differs. This masker
 * keeps the `user:****@` format because it feeds ~two dozen UI/log call
 * sites; callers that need the stricter output use the redactor directly.
 */
import { maskCredentialOccurrences } from '../security/ProxySecretRedactor';

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

            // If there's a password, mask it while preserving the non-secret
            // username for the established UI format.
            if (parsed.password) {
                parsed.password = '****';
                return this.maskCredentialOccurrences(parsed.toString());
            }

            // A username-only userinfo component is frequently a bearer/API token
            // (for example http://ghp_xxx@proxy). It cannot safely be distinguished
            // from a human username, so mask it completely.
            if (parsed.username) {
                parsed.username = '****';
                return this.maskCredentialOccurrences(parsed.toString());
            }

            if (parsed.host) {
                // Re-serialization can hide credentials in the path: WHATWG
                // treats "\" as "/" for special schemes, so an authority like
                // "DOMAIN\user:pass@proxy" parses as host "domain" with
                // "/user:pass@proxy" left in the path. Mask the serialized
                // result instead of returning it raw.
                return this.maskCredentialOccurrences(parsed.toString());
            }

            // Scheme-less "user:secret@host" parses as an opaque URL ("user:" is
            // taken as the scheme, the rest as the path) with no host and no
            // credentials — fall through to the text masker below.
        } catch {
            // Fall through to the text masker below.
        }

        return this.maskCredentialOccurrences(url);
    }

    /**
     * Masks every credential occurrence in arbitrary text (#108) through the
     * shared ProxySecretRedactor patterns: absolute URLs keep the
     * `user:****@` display format (userinfo without a password is masked
     * completely because it is commonly an API token) and scheme-less
     * `user:pass@host` sequences become `user:****@`. Plain email addresses
     * never match because the bare pattern requires a password part.
     */
    private maskCredentialOccurrences(text: string): string {
        return maskCredentialOccurrences(text, userinfo => {
            const separator = userinfo.indexOf(':');
            return separator === -1
                ? '****'
                : `${userinfo.slice(0, separator)}:****`;
        });
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
