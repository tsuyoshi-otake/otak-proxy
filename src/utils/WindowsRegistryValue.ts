/**
 * Reads values from `reg query` output. Shared by proxy detection and the
 * Windows diagnostics so both decide "enabled" the same way.
 */

/**
 * `<name>    REG_<TYPE>    <value>` as printed by `reg query`. Static (no value name
 * interpolated into a regex) and free of ambiguous quantifiers, so untrusted registry
 * output cannot steer the pattern.
 */
const REG_VALUE_LINE_PATTERN = /^\s*(\S+)\s+REG_\w+\s+(.+)$/i;
const REG_DWORD_PATTERN = /^(?:0x[0-9a-f]+|\d+)$/i;

export function parseRegValue(stdout: string, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const line of stdout.split(/\r?\n/)) {
        const match = REG_VALUE_LINE_PATTERN.exec(line);
        if (match && match[1].toLowerCase() === target) {
            return match[2].trim();
        }
    }
    return undefined;
}

/** A REG_DWORD flag is on when its value (`0x1`, `0x11`, `1`) is a non-zero integer. */
export function dwordIsEnabled(value: string | undefined): boolean {
    const trimmed = value?.trim();
    return Boolean(trimmed && REG_DWORD_PATTERN.test(trimmed) && Number(trimmed) !== 0);
}
