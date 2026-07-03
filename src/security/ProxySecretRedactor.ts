const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;
const HEADER_SECRET_PATTERN = /\b(Proxy-Authorization|Authorization)\s*:\s*([^\r\n]+)/gi;
const BASIC_SECRET_PATTERN = /\bBasic\s+[A-Za-z0-9+/]+={0,2}\b/g;
const NPM_AUTH_PATTERN = /^(\s*(?:\/\/[^=]+:)?_authToken\s*=\s*)(.+)$/gim;
const GIT_EXTRA_HEADER_PATTERN = /\b(http\.[^\s=]+\.extraHeader|http\.extraHeader)\s*[=\s]\s*([^\r\n]+)/gi;

function uniqueSecrets(secrets: readonly string[]): string[] {
    return [...new Set(secrets.filter(secret => secret.length > 0))];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export class ProxySecretRedactor {
    redactString(value: string, knownSecrets: readonly string[] = []): string {
        let redacted = value
            .replace(ANSI_ESCAPE_PATTERN, '<ansi>')
            .replace(HEADER_SECRET_PATTERN, '$1: <redacted>')
            .replace(BASIC_SECRET_PATTERN, 'Basic <redacted>')
            .replace(NPM_AUTH_PATTERN, '$1<redacted>')
            .replace(GIT_EXTRA_HEADER_PATTERN, '$1 <redacted>')
            .replace(URL_CREDENTIAL_PATTERN, '$1<credentials>@');

        for (const secret of uniqueSecrets(knownSecrets.flatMap(encodedForms))) {
            redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '<redacted>');
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
