/**
 * @file FileLease
 * @description Cross-process critical section backed by a lock file that
 * carries its owner's identity.
 *
 * Issue: #73
 *
 * Three places in this extension need one window to finish a multi-step file
 * or config update before another starts: the Git global config writes, the
 * instance registry, and the shared sync state compare-and-swap. All three
 * previously used the same hand-rolled pattern - create an empty file with
 * `wx`, treat it as stale once its mtime is old enough, and unlink it on the
 * way out - and that pattern loses mutual exclusion:
 *
 *   A acquires -> A's work outlives the stale window -> B deletes A's lock and
 *   takes its own -> A finishes and unlinks *B's* lock -> C walks in while B is
 *   still inside.
 *
 * A lease fixes both halves of that. The lock file names its owner, so release
 * can refuse to delete somebody else's lock; and a heartbeat refreshes the
 * lease while the owner is alive, so "old" only ever means "abandoned".
 *
 * Both properties are model-checked in `formal/SharedStateCas.tla`: dropping
 * either one makes TLC produce a two-holder counterexample (`TLC-CAS-LEASE-ABA`).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorCode } from './ErrorUtils';
import { Logger } from './Logger';

/**
 * Narrow filesystem protocol used by FileLease, so tests can inject faults
 * without touching the surrounding process filesystem.
 */
export type FileLeaseFileSystem = Pick<typeof fs,
    'openSync' | 'closeSync' | 'writeSync' | 'readFileSync' | 'writeFileSync' |
    'unlinkSync' | 'existsSync' | 'mkdirSync' | 'statSync'>;

export interface FileLeaseOptions {
    /** Absolute path of the lock file. Its directory is created on demand. */
    lockPath: string;
    /**
     * How long a lock stays valid without a heartbeat. A holder that stops
     * refreshing for longer than this is treated as abandoned.
     */
    leaseMs: number;
    /** How long to wait for the lock before giving up. */
    acquireTimeoutMs: number;
    /** Delay between acquisition attempts. */
    retryDelayMs?: number;
    /** How often the owner refreshes its lease. Defaults to a third of `leaseMs`. */
    heartbeatIntervalMs?: number;
    /** Human-readable name used in timeout messages. */
    name: string;
    fileSystem?: FileLeaseFileSystem;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    createToken?: () => string;
}

export interface FileLeaseRunOptions {
    /** Called once when acquisition has to wait for another holder. */
    onWaiting?: () => void;
}

interface LeaseRecord {
    token: string;
    pid: number;
    acquiredAt: number;
    heartbeatAt: number;
}

export class FileLeaseTimeoutError extends Error {
    constructor(name: string) {
        super(`Timed out acquiring ${name}`);
        this.name = 'FileLeaseTimeoutError';
    }
}

const DEFAULT_RETRY_DELAY_MS = 25;

function isLeaseRecord(value: unknown): value is LeaseRecord {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Partial<LeaseRecord>;
    return typeof record.token === 'string'
        && record.token.length > 0
        && typeof record.heartbeatAt === 'number';
}

/**
 * A cross-process mutex whose lock file records who holds it.
 */
export class FileLease {
    private readonly lockPath: string;
    private readonly leaseMs: number;
    private readonly acquireTimeoutMs: number;
    private readonly retryDelayMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly name: string;
    private readonly fileSystem: FileLeaseFileSystem;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly createToken: () => string;

    constructor(options: FileLeaseOptions) {
        this.lockPath = options.lockPath;
        this.leaseMs = options.leaseMs;
        this.acquireTimeoutMs = options.acquireTimeoutMs;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1, Math.floor(options.leaseMs / 3));
        this.name = options.name;
        this.fileSystem = options.fileSystem ?? fs;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.createToken = options.createToken ?? (() => crypto.randomBytes(16).toString('hex'));
    }

    /**
     * Runs `fn` while holding the lease. The lease is always released - or
     * deliberately left alone when it is no longer ours - before returning.
     *
     * @throws FileLeaseTimeoutError when the lock cannot be acquired in time
     */
    async run<T>(fn: () => Promise<T>, options: FileLeaseRunOptions = {}): Promise<T> {
        const token = await this.acquire(options);
        const heartbeat = this.startHeartbeat(token);
        try {
            return await fn();
        } finally {
            clearInterval(heartbeat);
            this.release(token);
        }
    }

    private async acquire(options: FileLeaseRunOptions): Promise<string> {
        const token = this.createToken();
        const deadline = this.now() + this.acquireTimeoutMs;
        let waitingReported = false;

        while (true) {
            if (this.tryCreate(token)) {
                return token;
            }

            // The deadline is checked on every attempt, reclaim or not, so that
            // a lock file we can never read cannot spin this loop forever.
            if (!this.reclaimIfAbandoned() && !waitingReported) {
                options.onWaiting?.();
                waitingReported = true;
            }

            if (this.now() > deadline) {
                throw new FileLeaseTimeoutError(this.name);
            }

            await this.sleep(this.retryDelayMs);
        }
    }

    private tryCreate(token: string): boolean {
        try {
            this.ensureLockDir();
            const record: LeaseRecord = {
                token,
                pid: process.pid,
                acquiredAt: this.now(),
                heartbeatAt: this.now()
            };
            const fd = this.fileSystem.openSync(this.lockPath, 'wx');
            try {
                this.fileSystem.writeSync(fd, JSON.stringify(record));
            } finally {
                this.fileSystem.closeSync(fd);
            }
            return true;
        } catch (error) {
            if (getErrorCode(error) === 'EEXIST') {
                return false;
            }
            throw error;
        }
    }

    private ensureLockDir(): void {
        const directory = path.dirname(this.lockPath);
        if (!this.fileSystem.existsSync(directory)) {
            this.fileSystem.mkdirSync(directory, { recursive: true });
        }
    }

    /**
     * Removes a lock whose owner stopped refreshing it.
     *
     * The file is re-read immediately before unlinking: if its contents changed
     * in between, somebody else already reclaimed it and this call must not
     * delete the new owner's lock.
     *
     * @returns true when the caller should retry acquisition
     */
    private reclaimIfAbandoned(): boolean {
        let raw: string;
        try {
            raw = this.fileSystem.readFileSync(this.lockPath, 'utf-8') as string;
        } catch {
            // Gone already (or unreadable): let the caller retry.
            return true;
        }

        if (this.now() - this.lastActivity(raw) <= this.leaseMs) {
            return false;
        }

        try {
            const stillTheSame = this.fileSystem.readFileSync(this.lockPath, 'utf-8') as string;
            if (stillTheSame !== raw) {
                return false;
            }
            this.fileSystem.unlinkSync(this.lockPath);
            Logger.warn(`Reclaimed abandoned ${this.name}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * When the lock file predates this format (or was truncated), its own
     * timestamp is the only evidence of activity available.
     */
    private lastActivity(raw: string): number {
        const record = this.parse(raw);
        if (record) {
            return record.heartbeatAt;
        }
        try {
            return this.fileSystem.statSync(this.lockPath).mtimeMs;
        } catch {
            return 0;
        }
    }

    private startHeartbeat(token: string): NodeJS.Timeout {
        const timer = setInterval(() => this.beat(token), this.heartbeatIntervalMs);
        timer.unref?.();
        return timer;
    }

    /**
     * Refreshes the lease, but only while the lock is still ours. Once it is
     * not, the heartbeat must not recreate it: that would take the lock away
     * from whoever reclaimed it.
     */
    private beat(token: string): void {
        try {
            const record = this.parse(this.fileSystem.readFileSync(this.lockPath, 'utf-8') as string);
            if (!record || record.token !== token) {
                return;
            }
            this.fileSystem.writeFileSync(
                this.lockPath,
                JSON.stringify({ ...record, heartbeatAt: this.now() }),
                'utf-8'
            );
        } catch {
            // A missing or unreadable lock file is handled at release time.
        }
    }

    /**
     * Releases the lease if it is still ours, and leaves it alone otherwise.
     *
     * Unlinking unconditionally is what turns a slow holder into a second
     * holder's missing lock.
     */
    private release(token: string): void {
        try {
            const record = this.parse(this.fileSystem.readFileSync(this.lockPath, 'utf-8') as string);
            if (!record) {
                // Not ours to interpret; it expires on its own.
                return;
            }
            if (record.token !== token) {
                Logger.warn(`Not releasing ${this.name}: it is held by another owner`);
                return;
            }
            this.fileSystem.unlinkSync(this.lockPath);
        } catch {
            // Already gone.
        }
    }

    private parse(raw: string): LeaseRecord | null {
        try {
            const parsed: unknown = JSON.parse(raw);
            return isLeaseRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
}
