const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// Three userinfo alternatives, tried left to right:
// 1) [^/\s]+ covers every well-formed absolute URL: userinfo has no "/" or
//    whitespace. It wins wherever it matches, so in
//    "https://user:pass@registry.example.com/@scope/pkg" the host stays visible.
// 2) [^/\s:@]+:(?:(?!:\/\/)\S)* covers a password with an unencoded "/", "?"
//    or "#" ("http://user:pa/ss@host:8080"), which a URL parser rejects or
//    splits at that character. The password run may contain "/", "?", "#",
//    "\" and "@" but never crosses another "://"; that bound keeps the scan
//    linear (without it, 140k characters of "x://a:b" take about 1.6 s).
// 3) [^/\s:@]+:[^@/\r\n]* covers a password with raw whitespace
//    ("http://user:pa ss@host:8080"), which the validator rejects but which
//    still reaches logs and messages carrying the rejected value. Unlike
//    alternatives 1 and 2 — which run to the LAST "@" of a whitespace-free
//    token — this run stops at the FIRST "@": a run that may contain spaces
//    would otherwise swallow the host whenever the line later contains an
//    e-mail address ("error: http://user:pa ss@host:8080 and mail me@corp").
//    The run excludes "/" so it cannot reach into a later URL's authority
//    (every scheme's "//" ends it) and excludes line breaks so it cannot
//    cross into the next line.
// Alternatives 1 and 2 are greedy and backtrack to the LAST "@" before the
// host, so a password with an unencoded "@" (http://user:p@ss@host) is fully
// consumed; alternative 3 is only tried when those fail.
// Accepted over-masking: a port followed by an "@" later in the same
// whitespace-free token has the same shape as a password containing "/" and
// cannot be told apart from it. "http://user:12/ss@host:8080" and
// "http://localhost:3000/@vite/client" are both valid URLs, and both are
// masked ("http://localhost:****@vite/client"). Alternative 3 adds the same
// over-masking for a port followed, on the same line and before any "/", by
// text containing an "@" ("see http://proxy:8080 is down, mail admin@corp"
// becomes "see http://proxy:****@corp"); hiding a port is the safe direction.
// Residual leaks for redactString, accepted (all as before #108): a password
// with raw whitespace AND a raw "/" ("http://user:pa ss/x@host"), a password
// with a raw line break ("http://user:pa<LF>ss@host"; alternative 3 stops at
// line breaks), the part after the first "@" of a password with raw
// whitespace AND a raw "@" ("http://user:pa ss@w@host" keeps "w"), and a
// scheme-less "user:pa ss@host". maskPassword masks the first two (the URL
// parser drops line breaks, and maskLooseCredentials covers text) and the
// third only for a standalone URL (the parser takes the last "@"); inside
// text it keeps "w", and it leaves the scheme-less one unmasked, both as
// before #108.
// Module-private (#108): /g regexes carry lastIndex state across calls, so
// callers go through maskCredentialOccurrences instead of touching the
// patterns directly.
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s]+|[^/\s:@]+:(?:(?!:\/\/)\S)*|[^/\s:@]+:[^@/\r\n]*)@/gi;
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

const LOOSE_WS = /\s/;

/**
 * The pre-#108 display-masker fallbacks, kept for InputSanitizer.maskPassword
 * (#108, PR #113 review): the display path must never show a password that
 * the pre-#108 masker hid. Only the display masker uses this — the passes
 * over-mask deliberately (the authority pass runs from any "//x:" to the next
 * "@" across spaces, "/", quotes and line breaks), which the display masker
 * accepted before #108 and the diagnostics redactor never did. Unlike the
 * pre-#108 masker, which replaced only the first authority match, both
 * passes are global.
 *
 * Each pass is a single left-to-right scan, not the original regexes, which
 * backtrack ("//a:b" x 28000 took about 1.6 s with the pre-#108 regex).
 * Pass 1 scans for "//"; every match starting between a "//" and the first
 * ":" or "@" after it ends at that same character, so they fail or succeed
 * together, and when no "@" follows a ":" terminator no later "//" can
 * match either. Pass 2 walks
 * each run of [^\s@/] characters ending at an "@"; the only possible starts
 * are the run start (when it begins the text or follows whitespace) or the
 * position right after an "=" inside the run, and the "first ':' at or after
 * the start" pointer only moves forward.
 */
export function maskLooseCredentials(text: string, passwordMask: string): string {
    return maskSchemelessPasswords(maskAuthorityPasswords(text, passwordMask), passwordMask);
}

// Pass 1, the pre-#108 /(\/\/[^:@]+):([^@]+)@/ made global: "//" + a user
// run of non-":" non-"@" characters + ":" + a password run of non-"@"
// characters + "@". Keeps "//user:" and "@", substitutes passwordMask for
// the password.
function maskAuthorityPasswords(text: string, passwordMask: string): string {
    const parts: string[] = [];
    let copied = 0;
    let cursor = 0;
    while (true) {
        const slashes = text.indexOf('//', cursor);
        if (slashes === -1) {
            break;
        }
        // First ":" or "@" after the "//" terminates the user run. Every
        // later "//" inside the run ends at the same character, so a failure
        // here rules out all of them.
        let end = slashes + 2;
        while (end < text.length && text[end] !== ':' && text[end] !== '@') {
            end++;
        }
        if (end >= text.length) {
            break;
        }
        if (text[end] === '@' || end === slashes + 2) {
            // Terminator "@" or empty user: later "//"s in the run end at the
            // same character and fail the same way, and no "@" search is done.
            cursor = end + 1;
            continue;
        }
        const at = text.indexOf('@', end + 1);
        if (at === -1) {
            // No "@" after this ":" — no later "//" can match either.
            break;
        }
        if (at === end + 1) {
            // Empty password: the "@" sits right after the ":".
            cursor = end + 1;
            continue;
        }
        parts.push(text.slice(copied, end + 1), passwordMask, '@');
        copied = at + 1;
        cursor = at + 1;
    }
    parts.push(text.slice(copied));
    return parts.join('');
}

// Pass 2, the pre-#108 /(^|[\s=])([^\s@:/]+):([^\s@/]+)@/g: a boundary
// (text start, whitespace or "=") + a user run of [^\s@:/] + ":" + a
// password run of [^\s@/] + "@". Keeps the boundary, the user and the
// trailing "@".
function maskSchemelessPasswords(text: string, passwordMask: string): string {
    const parts: string[] = [];
    let copied = 0;
    let cursor = 0;
    while (true) {
        const at = text.indexOf('@', cursor);
        if (at === -1) {
            break;
        }
        // The run of [^\s@/] characters that ends at this "@".
        let runStart = at;
        while (runStart > 0 && text[runStart - 1] !== '@' && text[runStart - 1] !== '/' && !LOOSE_WS.test(text[runStart - 1])) {
            runStart--;
        }
        // Candidate starts, leftmost first: the run start when it begins the
        // text or follows whitespace, then the position right after each "="
        // inside the run. `colon` is the first ":" at or after the current
        // candidate; the pointer only moves forward and never leaves the run.
        // Once no ":" remains before the "@" (or none would leave a non-empty
        // password) no later candidate can match either.
        let colon = runStart;
        let start = runStart === 0 || LOOSE_WS.test(text[runStart - 1]) ? runStart : -1;
        let eq = runStart;
        while (true) {
            if (start === -1) {
                while (eq < at && text[eq] !== '=') {
                    eq++;
                }
                if (eq >= at) {
                    break;
                }
                start = eq + 1;
                eq++;
            }
            if (colon < start) {
                colon = start;
            }
            while (colon < at && text[colon] !== ':') {
                colon++;
            }
            if (colon >= at - 1) {
                break;
            }
            if (colon > start) {
                parts.push(text.slice(copied, colon + 1), passwordMask, '@');
                copied = at + 1;
                break;
            }
            start = -1;
        }
        cursor = at + 1;
    }
    parts.push(text.slice(copied));
    return parts.join('');
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
 * (`user:****@host`) instead. Both use the patterns of
 * {@link maskCredentialOccurrences} (`<credentials>@` here, `****` there), but
 * their coverage differs: the display masker also masks the URL parser's view
 * of a single URL and runs {@link maskLooseCredentials}, so each masks some
 * shapes the other leaves (ARCHITECTURE.md, "Credential Masking").
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
