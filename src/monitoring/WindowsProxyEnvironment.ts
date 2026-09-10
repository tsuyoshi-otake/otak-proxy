import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

export const PROXY_ENVIRONMENT_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;
export type ProxyEnvironmentName = typeof PROXY_ENVIRONMENT_NAMES[number];
export type SavedProxyEnvironment = Record<ProxyEnvironmentName, string | null>;
export interface WindowsProxyEnvironmentSnapshot {
    user: SavedProxyEnvironment;
    machine: SavedProxyEnvironment;
}

// Fixed input only. Neither proxy values nor exception details enter argv/logs.
export const READ_PROXY_ENVIRONMENT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = @{}
foreach ($scope in @('User', 'Machine')) {
    $values = @{}
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        $values[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]$scope)
    }
    $result[$scope.ToLowerInvariant()] = $values
}
ConvertTo-Json -InputObject $result -Compress
`;

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWindowsProxyEnvironment(stdout: string): WindowsProxyEnvironmentSnapshot {
    const result: unknown = JSON.parse(stdout);
    if (!isRecord(result)) {
        throw new Error('Invalid environment response');
    }
    for (const scope of ['user', 'machine']) {
        const values = result[scope];
        if (!isRecord(values) || !PROXY_ENVIRONMENT_NAMES.every(name =>
            Object.hasOwn(values, name) && (values[name] === null || typeof values[name] === 'string'))) {
            throw new Error('Incomplete environment response');
        }
    }
    return result as unknown as WindowsProxyEnvironmentSnapshot;
}

export async function readWindowsProxyEnvironment(signal: AbortSignal): Promise<WindowsProxyEnvironmentSnapshot> {
    const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', READ_PROXY_ENVIRONMENT_SCRIPT
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, signal });
    return parseWindowsProxyEnvironment(stdout);
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
                const saved = snapshot.user[name] ?? snapshot.machine[name];
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
