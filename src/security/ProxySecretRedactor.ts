const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// Greedy credential part: backtracks to the LAST "@" before the host, so
// passwords containing an unencoded "@" (http://user:p@ss@host) are fully consumed.
// Module-private (#108): /g regexes carry lastIndex state across calls, so
// callers go through maskCredentialOccurrences instead of touching the
// patterns directly.
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s]+)@/gi;
// Scheme-less "user:pass@host" as returned by git/npm config reads. Requires a
// ":" between user and password so plain email addresses never match. The
// boundary also accepts "/", ":", "@" and "\" so credentials embedded inside a
// mangled URL ("http://domain/user:pass@proxy" from a "DOMAIN\user" authority)
// or right after another credential still match. May over-redact exotic prose
// containing ":...@"; that is the safe direction here.
const BARE_CREDENTIAL_PATTERN = /(^|[\s"'=(,;/:@\\])([^\s@/:"']+):([^\s@/"']+)@/gm;
const HEADER_SECRET_PATTERN = /\b(Proxy-Authorization|Authorization)\s*:\s*([^\r\n]+)/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[A-Za-z0-9+/]+={0,2}\b/g;
const NPM_AUTH_PATTERN = /^(\s*(?:\/\/[^=]+:)?_authToken\s*=\s*)(.+)$/gim;
const GIT_EXTRA_HEADER_PATTERN = /\b(http\.[^\s=]+\.extraHeader|http\.extraHeader)\s*[=\s]\s*([^\r\n]+)/gi;

function uniqueSecrets(secrets: readonly string[]): string[] {
    return [...new Set(secrets.filter(secret => secret.length > 0))];
}

/** Literal (non-regex) global replace: no dynamic RegExp, no `$`-pattern surprises. */
function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
    return haystack.split(needle).join(replacement);
}

/**
 * Masks every credential occurrence in `text` with a caller-chosen
 * replacement (#108): the whole matched userinfo (everything before the "@")
 * is passed to `maskUserinfo` and replaced by its result. ProxySecretRedactor
 * substitutes `<credentials>`; the InputSanitizer display masker keeps the
 * username and substitutes `****` for the password. Exported as a function —
 * rather than the patterns themselves — so the /g regexes stay private and
 * the two callers can never drift on what counts as a credential.
 */
export function maskCredentialOccurrences(text: string, maskUserinfo: (userinfo: string) => string): string {
    return text
        .replace(URL_CREDENTIAL_PATTERN, (_match, scheme: string, userinfo: string) =>
            `${scheme}${maskUserinfo(userinfo)}@`)
        .replace(BARE_CREDENTIAL_PATTERN, (_match, boundary: string, user: string, password: string) =>
            `${boundary}${maskUserinfo(`${user}:${password}`)}@`);
}

function encodedForms(secret: string): string[] {
    const forms = [secret];
    try {
        forms.push(encodeURIComponent(secret));
    } catch {
        // keep raw form only
    }
    try {
        forms.push(Buffer.from(secret, 'utf8').toString('base64'));
    } catch {
        // keep raw form only
    }
    return forms;
}

/**
 * ProxySecretRedactor - the strict, general-purpose redactor for arbitrary
 * diagnostics/remediation/sync text and object graphs. It fully masks credentials
 * (`<credentials>@`) and also strips Authorization/Basic headers, npm auth tokens,
 * Git extraHeaders, caller-supplied known secrets (incl. url/base64 encodings),
 * and control/ANSI sequences.
 *
 * Redaction overlap (#16, #108): the Logger/UI hot path uses the lighter,
 * username-preserving {@link ../validation/InputSanitizer.InputSanitizer}
 * (`user:****@host`) instead. Both apply credentials through
 * {@link maskCredentialOccurrences}, so they match the same occurrences and
 * differ only in the replacement text (`<credentials>@` here, `****` there).
 * This redactor additionally strips Authorization/Basic
 * headers, npm auth tokens, Git extraHeaders, caller-supplied known secrets,
 * and control/ANSI sequences.
 */
export class ProxySecretRedactor {
    redactString(value: string, knownSecrets: readonly string[] = []): string {
        let redacted = value
            .replace(ANSI_ESCAPE_PATTERN, '<ansi>')
            .replace(HEADER_SECRET_PATTERN, '$1: <redacted>')
            .replace(BASIC_SECRET_PATTERN, 'Basic <redacted>')
            .replace(NPM_AUTH_PATTERN, '$1<redacted>')
            .replace(GIT_EXTRA_HEADER_PATTERN, '$1 <redacted>');

        redacted = maskCredentialOccurrences(redacted, () => '<credentials>');

        for (const secret of uniqueSecrets(knownSecrets.flatMap(encodedForms))) {
            redacted = replaceAllLiteral(redacted, secret, '<redacted>');
        }

        return redacted.replace(CONTROL_CHAR_PATTERN, char => {
            switch (char) {
                case '\r':
                    return '\\r';
                case '\n':
                    return '\\n';
                case '\t':
                    return '\\t';
                default:
                    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
            }
        });
    }

    redactValue<T>(value: T, knownSecrets: readonly string[] = []): T {
        return this.redactUnknown(value, knownSecrets, new WeakSet<object>()) as T;
    }

    private redactUnknown(value: unknown, knownSecrets: readonly string[], seen: WeakSet<object>): unknown {
        if (typeof value === 'string') {
            return this.redactString(value, knownSecrets);
        }

        if (value === null || typeof value !== 'object') {
            return value;
        }

        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return value.map(item => this.redactUnknown(item, knownSecrets, seen));
        }

        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            const sanitizedKey = this.redactString(key, knownSecrets);
            output[sanitizedKey] = this.redactUnknown(child, knownSecrets, seen);
        }
        return output;
    }
}
