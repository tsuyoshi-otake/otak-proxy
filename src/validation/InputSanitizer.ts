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
 * secrets. Userinfo is also masked completely when the password is empty
 * (a token-like username) or when the part before the first ":" contains a
 * raw "@". Both use the shared patterns of
 * {@link ../security/ProxySecretRedactor.maskCredentialOccurrences}, but their
 * coverage differs: this masker also masks the URL parser's view of a single
 * URL and runs the pre-#108 loose fallbacks (`maskLooseCredentials`), so each
 * masks some shapes the other leaves (ARCHITECTURE.md, "Credential Masking").
 * This masker keeps the `user:****@` format because it feeds ~two dozen
 * UI/log call sites; callers that need the stricter output use the redactor
 * directly.
 */
import { maskCredentialOccurrences, maskLooseCredentials } from '../security/ProxySecretRedactor';

export class InputSanitizer {
    // Empty-port authority shape ("http://user:/pass@host" or
    // "http://aa:\SECRET@host"): the URL parser reads "user:" as the host
    // with an empty port and moves the password into the path, so the
    // serialized form no longer has a ":" after the user and the credential
    // patterns cannot find it. The run before the second ":" excludes "@", so
    // the parsed URL has no userinfo on this path. Anchored at the start, so
    // one linear check; applied to the value as typed — with TAB, LF and CR
    // removed because the URL parser drops those characters before it
    // parses — and only when the typed value's parse has no userinfo.
    // The same happens with an all-digit password that the removed TAB/LF/CR
    // joins to a "?", "#", "/" or "\" ("http://user:8080<TAB>#@host" parses
    // as host "user", port 8080): the password would be shown as the port,
    // so a digit port counts too when an "@" follows it later in the value.
    private static readonly EMPTY_PORT_AUTHORITY =
        /^[\u0000-\u0020]*[a-z][a-z0-9+.-]*:[\/\\]*[^\/?#\\@]*:(?:[\/?#\\]|\d+[\/?#\\][^]*@)/i;

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
        // The path (parse path or loose pass) is decided on the value as
        // typed, as the pre-#108 masker did, so masking can never move a
        // value between the two paths.
        const raw = InputSanitizer.tryParseUrl(url);
        if (!raw?.host) {
            // The value does not parse, or parses without a host: the paths
            // on which the pre-#108 masker ran its fallbacks, so the loose
            // pass covers everything it hid. Values on this branch are
            // shown as typed.
            return maskLooseCredentials(this.maskCredentialOccurrences(url), '****');
        }
        // Parsed with a host but no userinfo, and the authority ends in an
        // empty port: the parser read "user:" as host and port and moved the
        // password into the path, query or fragment ("http://user:/pa
        // ss@host:8080" serializes as "http://user/pa%20ss@host:8080"; the
        // pre-#108 masker showed it too), so run the loose pass on the
        // value as typed and show it as typed.
        if (!raw.username && !raw.password
            && InputSanitizer.EMPTY_PORT_AUTHORITY.test(url.replace(/[\t\n\r]/g, ''))) {
            return maskLooseCredentials(this.maskCredentialOccurrences(url), '****');
        }
        // The premasked parse is used only when it keeps the host, the
        // username and the presence of a password of the typed value's
        // parse: the premask may only hide text, and when it changes what the
        // parser reads as the authority, the typed value's parse decides
        // ("http://TOKEN:@h?a:b@host"). The premasked parse still covers
        // shapes the typed parse misses, such as
        // "http://DOMAIN\user:pa\ss@proxy:8080" (host "domain" in both
        // parses).
        const premasked = this.maskCredentialOccurrences(url);
        const masked = premasked === url ? undefined : InputSanitizer.tryParseUrl(premasked);
        const parsed = masked
            && masked.host === raw.host
            && masked.username === raw.username
            && (masked.password === '') === (raw.password === '')
            ? masked
            : raw;
        // If there's a password, mask it while preserving the non-secret
        // username for the established UI format. A username-only userinfo
        // component is frequently a bearer/API token (for example
        // http://ghp_xxx@proxy); it cannot safely be distinguished from a
        // human username, so mask it completely.
        if (parsed.password) {
            parsed.password = '****';
        } else if (parsed.username) {
            parsed.username = '****';
        }
        // Mask the serialized form again: the parser rewrites the text
        // ("\" becomes "/" for special schemes, tab and line breaks are
        // removed), and a credential can appear only after that rewrite:
        // "http://proxy/u:p<TAB>ass@h" serializes as "http://proxy/u:pass@h".
        return this.maskCredentialOccurrences(parsed.toString());
    }

    private static tryParseUrl(value: string): URL | undefined {
        try {
            return new URL(value);
        } catch {
            return undefined;
        }
    }

    /**
     * Masks every credential occurrence in arbitrary text (#108) through the
     * shared ProxySecretRedactor patterns: absolute URLs keep the
     * `user:****@` display format (userinfo without a password is masked
     * completely because it is commonly an API token) and scheme-less
     * `user:pass@host` sequences become `user:****@`. A userinfo with an
     * empty password ("user:@host") leaves a token-like username, so it is
     * masked completely as the pre-#108 username-only rule did; a raw "@"
     * before the ":" means the match ran past the userinfo the parser reads
     * (the URL pattern's userinfo runs to the last "@"), and the pre-#108
     * masker hid the part before the first "@", so the whole userinfo is
     * masked then too. Plain email addresses never match because the bare
     * pattern requires a password part.
     */
    private maskCredentialOccurrences(text: string): string {
        return maskCredentialOccurrences(text, userinfo => {
            const separator = userinfo.indexOf(':');
            return separator === -1
                || separator === userinfo.length - 1
                || userinfo.slice(0, separator).includes('@')
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
