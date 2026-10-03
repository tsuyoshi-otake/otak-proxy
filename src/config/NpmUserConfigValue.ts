/**
 * Reads one top-level value from an npm user config file (`.npmrc`) the way
 * npm loads it, for the values `npm config get` refuses to print (#85).
 *
 * npm stores user config with its bundled `ini` package (5.0.0 in npm 10.9.9,
 * 6.0.0 in npm 11.16.0; their `lib/ini.js` is identical). Decoding follows
 * `ini.decode` / `unsafe`:
 * - lines are split on CR/LF; blank lines and `;`/`#` comment lines are skipped
 * - `[section]` starts a section; only keys before the first section are top-level
 * - `key = value` splits at the first `=`; key and value are trimmed
 * - a quoted value is JSON-decoded (single quotes are stripped first)
 * - otherwise an unescaped `;` or `#` ends the value; `\;`, `\#` and `\\`
 *   are unescaped and any other `\x` is kept as written
 * - the last assignment of a key wins; a `key[]` line turns the key into an
 *   array for the rest of the file
 *
 * Returns null when the key is absent or holds something this reader cannot
 * reproduce exactly: an array (`key[]`), a bare flag, `true`/`false`/`null`,
 * a non-string JSON value, a `${VAR}` reference that npm would expand from the
 * environment, or a `[key]`/`[key.sub]` section that replaces the value with
 * an object. Callers must treat null as "not verifiable", never as a
 * successful read.
 */
export function readTopLevelNpmrcString(text: string, key: string): string | null {
    let value: string | null = null;
    let inSection = false;
    let isArray = false;
    for (const line of text.split(/[\r\n]+/)) {
        if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) {
            continue;
        }
        const section = /^\[([^\]]*)\]\s*$/.exec(line);
        if (section) {
            const name = unescapeIniValue(section[1]);
            if (name === key || name?.startsWith(`${key}.`)) {
                return null;
            }
            inSection = true;
            continue;
        }
        const match = /^([^=]+)(=(.*))?$/.exec(line);
        if (inSection || !match) {
            continue;
        }
        const lineKey = unescapeIniValue(match[1]);
        if (lineKey === `${key}[]`) {
            isArray = true;
        } else if (lineKey === key) {
            value = match[2] === undefined ? null : toLoadedString(unescapeIniValue(match[3]));
        }
    }
    return isArray ? null : value;
}

function toLoadedString(decoded: string | null): string | null {
    if (decoded === null || decoded === 'true' || decoded === 'false' || decoded === 'null' || decoded.includes('${')) {
        return null;
    }
    return decoded;
}

/** `ini.unsafe`. Null when a quoted value decodes to a non-string JSON value. */
function unescapeIniValue(raw: string): string | null {
    let val = raw.trim();
    if (isQuoted(val)) {
        if (val.charAt(0) === '\'') {
            val = val.slice(1, -1);
        }
        try {
            const parsed: unknown = JSON.parse(val);
            return typeof parsed === 'string' ? parsed : null;
        } catch {
            return val;
        }
    }

    let escaped = false;
    let out = '';
    for (const c of val) {
        if (escaped) {
            out += '\\;#'.includes(c) ? c : `\\${c}`;
            escaped = false;
        } else if (c === ';' || c === '#') {
            break;
        } else if (c === '\\') {
            escaped = true;
        } else {
            out += c;
        }
    }
    if (escaped) {
        out += '\\';
    }
    return out.trim();
}

function isQuoted(val: string): boolean {
    return (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith('\'') && val.endsWith('\''));
}
