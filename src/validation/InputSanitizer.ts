/**
 * InputSanitizer - Sanitizes proxy URLs for safe display in logs, UI, and error messages
 * 
 * This class ensures that sensitive credentials (passwords) are never exposed in:
 * - Log files
 * - UI elements (status bar, notifications)
 * - Error messages
 * - Any other display contexts
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
            }
            
            return parsed.toString();
        } catch {
            // If URL parsing fails, try to mask password using regex
            // This handles edge cases where URL is malformed but still contains credentials
            // Pattern: looks for :password@ (password between : and @, but not at the start of URL)
            // We need to ensure we're matching the password in credentials, not a port number
            // Look for pattern: //username:password@ or ://username:password@
            const credentialPattern = /(\/\/[^:@]+):([^@]+)@/;
            const match = url.match(credentialPattern);
            
            if (match && match[1] && match[2]) {
                // Replace the password (everything after : and before @)
                // Keep the username part (match[1] includes //username)
                return url.replace(credentialPattern, '$1:****@');
            }
            
            // If no credentials found, return the original URL
            return url;
        }
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
