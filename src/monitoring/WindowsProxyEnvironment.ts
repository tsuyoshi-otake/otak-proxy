import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

export const PROXY_ENVIRONMENT_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;
export type ProxyEnvironmentName = typeof PROXY_ENVIRONMENT_NAMES[number];
/**
 * The saved values of one scope. `null`: the value is absent. `''`: present and
 * empty. `undefined`: present, but its text is not known, because `reg.exe`
 * writes the console code page and a value with a character at or above
 * U+0080 cannot be decoded reliably; the monitor does not compare it.
 */
export type SavedProxyEnvironment = Record<ProxyEnvironmentName, string | null | undefined>;
export interface WindowsProxyEnvironmentSnapshot {
    user: SavedProxyEnvironment;
    machine: SavedProxyEnvironment;
}

const execFileAsync = promisify(execFile);

type ExecFileAsync = (
    file: string,
    args: string[],
    options: { encoding: 'utf8'; windowsHide: boolean; timeout: number; maxBuffer: number; signal: AbortSignal }
) => Promise<{ stdout: string }>;

// The key each scope is saved under: the name `reg query` is given, and the
// path it prints as the header of its output.
const ENVIRONMENT_KEYS = {
    user: { query: 'HKCU\\Environment', header: 'HKEY_CURRENT_USER\\Environment' },
    machine: {
        query: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
        header: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    }
} as const;

/**
 * `    <name>    REG_<TYPE>    <value>`: exactly four spaces between the parts,
 * so leading spaces of a value are kept, and an empty value may omit the last
 * separator. The `s` flag keeps a raw line feed inside a value. Static and
 * linear, so untrusted registry text cannot steer it.
 */
const REG_VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/s;
const NON_ASCII = /[\u0080-\u{10FFFF}]/u;

/**
 * `ExpandEnvironmentStrings`: `%NAME%` becomes its value (names are
 * case-insensitive); an unknown name copies `%NAME` and resumes at its closing
 * `%`, which can open the next name; a lone `%` stays.
 */
function expandEnvironmentStrings(text: string, environment: NodeJS.ProcessEnv): string {
    const values = new Map<string, string>();
    for (const [name, value] of Object.entries(environment)) {
        if (value !== undefined) {
            values.set(name.toUpperCase(), value);
        }
    }
    let expanded = '';
    let position = 0;
    while (position < text.length) {
        const open = text.indexOf('%', position);
        const close = open === -1 ? -1 : text.indexOf('%', open + 1);
        if (close === -1) {
            expanded += text.slice(position);
            break;
        }
        expanded += text.slice(position, open);
        const value = values.get(text.slice(open + 1, close).toUpperCase());
        if (value === undefined) {
            expanded += text.slice(open, close);
            position = close;
        } else {
            expanded += value;
            position = close + 1;
        }
    }
    return expanded;
}

/**
 * The four proxy variables of one key, from the output of `reg query <key>`
 * (decoded as UTF-8). It throws, with a fixed message, when the output is not
 * that key's listing or names a variable twice: a failed read must never pass
 * for an absent variable. Lines after the header that are not value lines (a
 * subkey path, the continuation of another variable's multi-line value) are
 * skipped, and so are the key's other variables. REG_SZ gives its text,
 * REG_EXPAND_SZ the text expanded with `expansionEnvironment`, and any other
 * type `null` (`GetEnvironmentVariable` reads those as null too). The error
 * never carries output text: values may be credentials.
 */
export function parseRegQueryEnvironment(
    stdout: string,
    keyPath: string,
    expansionEnvironment: NodeJS.ProcessEnv = process.env
): SavedProxyEnvironment {
    const lines = stdout.split('\r\n');
    const header = lines.findIndex(line => line.trim() !== '');
    if (header === -1 || lines[header].toUpperCase() !== keyPath.toUpperCase()) {
        throw new Error('Unexpected reg query output');
    }
    const saved: SavedProxyEnvironment = { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null };
    const seen = new Set<string>();
    for (const line of lines.slice(header + 1)) {
        const match = REG_VALUE_LINE.exec(line);
        const name = match?.[1].toUpperCase() as ProxyEnvironmentName | undefined;
        if (!match || !name || !PROXY_ENVIRONMENT_NAMES.includes(name)) {
            continue;
        }
        if (seen.has(name)) {
            throw new Error('Duplicate variable in reg query output');
        }
        seen.add(name);
        const [, , type, raw = ''] = match;
        if (type !== 'REG_SZ' && type !== 'REG_EXPAND_SZ') {
            continue;
        }
        if (NON_ASCII.test(raw)) {
            saved[name] = undefined;
        } else {
            saved[name] = type === 'REG_EXPAND_SZ' ? expandEnvironmentStrings(raw, expansionEnvironment) : raw;
        }
    }
    return saved;
}

// Fixed input only. Neither proxy values nor exception details enter argv/logs.
// Whole-key queries, one process at a time: the key lists every variable, so
// the buffer is sized for a 32,767-character PATH.
export async function readWindowsProxyEnvironment(
    signal: AbortSignal,
    exec: ExecFileAsync = execFileAsync
): Promise<WindowsProxyEnvironmentSnapshot> {
    const query = async (scope: keyof typeof ENVIRONMENT_KEYS): Promise<SavedProxyEnvironment> => {
        const { stdout } = await exec('reg', ['query', ENVIRONMENT_KEYS[scope].query], {
            encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, signal
        });
        return parseRegQueryEnvironment(stdout, ENVIRONMENT_KEYS[scope].header);
    };
    const user = await query('user');
    return { user, machine: await query('machine') };
}

interface WatchOptions {
    read?: (signal: AbortSignal) => Promise<WindowsProxyEnvironmentSnapshot>;
    environment?: NodeJS.ProcessEnv;
    notify: (names: ProxyEnvironmentName[]) => void;
    canNotify?: () => boolean;
    isFocused?: () => boolean;
    now?: () => number;
    random?: () => number;
}

/** Read-only notification monitor. It never participates in proxy selection or application. */
export class WindowsProxyEnvironmentMonitor {
    private readonly observed = new Set<ProxyEnvironmentName>();
    private readonly abort = new AbortController();
    private timer?: NodeJS.Timeout;
    private inFlight?: Promise<void>;
    private started = false;
    private disposed = false;
    private failures = 0;
    private lastNotified?: string;
    private lastNotificationAt = -Infinity;

    constructor(private readonly options: WatchOptions) {}

    start(): void {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        void this.poll();
    }

    private async poll(): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (this.options.isFocused?.() !== false) {
            await this.check();
        }
        if (!this.disposed) {
            const base = Math.min(60_000 * 2 ** this.failures, 750_000);
            const delay = this.failures ? base * (1 + (this.options.random ?? Math.random)() * 0.2) : base;
            this.timer = setTimeout(() => { void this.poll(); }, delay);
            this.timer.unref?.();
        }
    }

    check(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (!this.inFlight) {
            this.inFlight = this.readAndCompare().finally(() => { this.inFlight = undefined; });
        }
        return this.inFlight;
    }

    private async readAndCompare(): Promise<void> {
        // The monitor only notifies: with notifications off there is nothing to
        // read, so no process is started and nothing is observed.
        if (this.options.canNotify?.() === false) {
            return;
        }
        try {
            const snapshot = await (this.options.read ?? readWindowsProxyEnvironment)(this.abort.signal);
            if (this.disposed) {
                return;
            }
            this.failures = 0;
            const environment = this.options.environment ?? process.env;
            const processValues = new Map(Object.entries(environment).map(([name, value]) => [name.toUpperCase(), value]));
            const mismatches: Array<[ProxyEnvironmentName, string | null, string | null]> = [];
            for (const name of PROXY_ENVIRONMENT_NAMES) {
                // An unknown value (undefined) is neither compared nor observed;
                // an unset or empty user value defers to the machine value.
                const user = snapshot.user[name];
                const saved = user === undefined ? undefined : user || snapshot.machine[name];
                if (saved === undefined) {
                    continue;
                }
                if (saved !== null) {
                    this.observed.add(name);
                }
                const current = processValues.get(name) || null;
                if (this.observed.has(name) && (saved || null) !== current) {
                    mismatches.push([name, saved || null, current]);
                }
            }
            if (!mismatches.length) {
                // A later recurrence is a new incident, even when its values are
                // identical to an earlier mismatch that has since been resolved.
                this.lastNotified = undefined;
                return;
            }
            if (this.options.canNotify?.() === false) {
                return;
            }
            const fingerprint = createHash('sha256').update(JSON.stringify(mismatches)).digest('hex');
            const now = (this.options.now ?? Date.now)();
            if (fingerprint === this.lastNotified || now - this.lastNotificationAt < 300_000) {
                return;
            }
            this.options.notify(mismatches.map(([name]) => name));
            this.lastNotified = fingerprint;
            this.lastNotificationAt = now;
        } catch {
            // Unknown is not absent. Keep observation history and retry at the next
            // backed-off poll. Command errors may contain credentials: never log them.
            this.failures = Math.min(this.failures + 1, 4);
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.abort.abort();
    }
}
