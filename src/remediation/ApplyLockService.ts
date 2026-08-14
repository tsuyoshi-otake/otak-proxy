import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TargetHost } from '../core/v3Types';

export type ApplyLockScope = 'hostUser' | 'profile' | 'workspaceHost';

export interface ApplyLockRequest {
    targetId: string;
    targetHost: TargetHost;
    scope: ApplyLockScope;
}

interface ApplyLockRecord {
    version: 1;
    token: string;
    targetId: string;
    targetHost: TargetHost;
    scope: ApplyLockScope;
    ownerPid: number;
    ownerHost: string;
    acquiredAt: number;
    expiresAt: number;
}

export interface ApplyLockHandle {
    target: ApplyLockRequest;
    token: string;
    path: string;
}

export interface ApplyLockAcquireResult {
    acquired: boolean;
    handle?: ApplyLockHandle;
    reason?: 'held' | 'ioError';
    holder?: Partial<ApplyLockRecord>;
}

export interface ApplyLockServiceOptions {
    baseDir?: string;
    now?: () => number;
}

export interface WithLocksOptions {
    /**
     * Fixed wait schedule applied when a lock is held by another window: wait
     * retryDelaysMs[0], re-try the acquire, wait retryDelaysMs[1], ... The
     * index is shared across all targets, so the total added wait is bounded
     * by the schedule's sum regardless of how many targets are contended.
     * Default [] preserves the historical single-attempt behavior (#30).
     */
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}

function stableUserName(): string {
    try {
        return os.userInfo().username;
    } catch {
        return process.env.USERNAME || process.env.USER || 'unknown';
    }
}

function hashLockName(target: ApplyLockRequest): string {
    const scope = [
        target.scope,
        target.targetHost,
        target.targetId,
        os.hostname(),
        stableUserName()
    ].join('\n');
    return crypto.createHash('sha256').update(scope).digest('hex');
}

function isErrno(error: unknown, code: string): boolean {
    return typeof error === 'object' &&
        error !== null &&
        (error as NodeJS.ErrnoException).code === code;
}

export class ApplyLockService {
    private readonly baseDir: string;
    private readonly now: () => number;

    constructor(options: ApplyLockServiceOptions = {}) {
        // OTAK_PROXY_LOCK_DIR lets tests point the shared apply lock at a hermetic
        // per-run directory (like GIT_CONFIG_GLOBAL / NPM_CONFIG_USERCONFIG do for
        // git/npm), so a lock left by one run cannot make another run's apply skip.
        this.baseDir = options.baseDir
            ?? process.env.OTAK_PROXY_LOCK_DIR
            ?? path.join(os.tmpdir(), 'otak-proxy-v3-locks');
        this.now = options.now ?? (() => Date.now());
    }

    async tryAcquire(target: ApplyLockRequest, ttlMs: number): Promise<ApplyLockAcquireResult> {
        await fs.mkdir(this.baseDir, { recursive: true });
        const lockPath = path.join(this.baseDir, `${hashLockName(target)}.lock.json`);
        const token = crypto.randomBytes(16).toString('hex');
        const acquiredAt = this.now();
        const record: ApplyLockRecord = {
            version: 1,
            token,
            targetId: target.targetId,
            targetHost: target.targetHost,
            scope: target.scope,
            ownerPid: process.pid,
            ownerHost: os.hostname(),
            acquiredAt,
            expiresAt: acquiredAt + ttlMs
        };

        const created = await this.tryCreateLock(lockPath, record);
        if (created) {
            return { acquired: true, handle: { target, token, path: lockPath } };
        }

        const holder = await this.readLock(lockPath);
        if (!holder) {
            // A peer may be renewing its lease with an in-place write at this
            // exact instant. If a lock path still exists but is temporarily
            // unreadable, fail closed: it is safer to report contention than
            // to mistake a live lock for an I/O failure or reclaim it.
            if (await this.lockPathExists(lockPath)) {
                return { acquired: false, reason: 'held' };
            }

            // The holder may have released between our failed exclusive create
            // and read. Retry the create once so a vanished lock does not turn
            // into a spurious I/O error.
            const createdAfterRelease = await this.tryCreateLock(lockPath, record);
            return createdAfterRelease
                ? { acquired: true, handle: { target, token, path: lockPath } }
                : { acquired: false, reason: 'held' };
        }

        if (holder.expiresAt > this.now()) {
            return { acquired: false, reason: 'held', holder: this.publicHolder(holder) };
        }

        const stalePath = `${lockPath}.stale.${process.pid}.${token}`;
        try {
            await fs.rename(lockPath, stalePath);
            await fs.unlink(stalePath).catch(() => undefined);
        } catch {
            return { acquired: false, reason: 'held', holder: this.publicHolder(holder) };
        }

        const createdAfterStale = await this.tryCreateLock(lockPath, record);
        return createdAfterStale
            ? { acquired: true, handle: { target, token, path: lockPath } }
            : { acquired: false, reason: 'held', holder: this.publicHolder(holder) };
    }

    async release(handle: ApplyLockHandle): Promise<boolean> {
        const record = await this.readLock(handle.path);
        if (!record || record.token !== handle.token) {
            return false;
        }

        try {
            await fs.unlink(handle.path);
            return true;
        } catch (error) {
            return isErrno(error, 'ENOENT');
        }
    }

    /**
     * Extends the lease of a lock this process still holds. No-ops (returns
     * false) when the lock was reclaimed by another holder in the meantime.
     */
    async renew(handle: ApplyLockHandle, ttlMs: number): Promise<boolean> {
        const record = await this.readLock(handle.path);
        if (!record || record.token !== handle.token) {
            return false;
        }

        const renewed: ApplyLockRecord = { ...record, expiresAt: this.now() + ttlMs };
        try {
            await fs.writeFile(handle.path, JSON.stringify(renewed), 'utf8');
            return true;
        } catch {
            return false;
        }
    }

    async withLocks<T>(
        targets: readonly ApplyLockRequest[],
        ttlMs: number,
        task: () => Promise<T>,
        options: WithLocksOptions = {}
    ): Promise<{ acquired: true; value: T } | { acquired: false; failed: ApplyLockAcquireResult }> {
        const retryDelaysMs = options.retryDelaysMs ?? [];
        const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const acquired: ApplyLockHandle[] = [];
        // The critical section (diagnostics passes, delayed retries) can
        // legitimately outlive ttlMs. Keep the lease alive while the task runs
        // so other windows never see the lock as stale and reclaim it mid-flight.
        const renewEveryMs = Math.max(50, Math.floor(ttlMs / 3));
        const renewTimer = setInterval(() => {
            for (const handle of acquired) {
                void this.renew(handle, ttlMs);
            }
        }, renewEveryMs);
        renewTimer.unref?.();
        try {
            let delayIndex = 0;
            for (const target of [...targets].sort((a, b) => a.targetId.localeCompare(b.targetId))) {
                let result = await this.tryAcquire(target, ttlMs);
                // Only contention ('held') is worth waiting out — the usual
                // holder is another window finishing the same convergence and
                // releasing within a few seconds. ioError won't heal by waiting.
                while (!result.acquired && result.reason === 'held' && delayIndex < retryDelaysMs.length) {
                    await sleep(retryDelaysMs[delayIndex]);
                    delayIndex += 1;
                    result = await this.tryAcquire(target, ttlMs);
                }
                if (!result.acquired || !result.handle) {
                    return { acquired: false, failed: result };
                }
                acquired.push(result.handle);
            }
            return { acquired: true, value: await task() };
        } finally {
            clearInterval(renewTimer);
            for (const handle of acquired.reverse()) {
                await this.release(handle);
            }
        }
    }

    private async tryCreateLock(lockPath: string, record: ApplyLockRecord): Promise<boolean> {
        let file: fs.FileHandle | undefined;
        try {
            file = await fs.open(lockPath, 'wx');
            await file.writeFile(JSON.stringify(record), 'utf8');
            return true;
        } catch (error) {
            if (isErrno(error, 'EEXIST')) {
                return false;
            }
            throw error;
        } finally {
            await file?.close();
        }
    }

    private async readLock(lockPath: string): Promise<ApplyLockRecord | undefined> {
        try {
            const raw = await fs.readFile(lockPath, 'utf8');
            return JSON.parse(raw) as ApplyLockRecord;
        } catch {
            return undefined;
        }
    }

    private async lockPathExists(lockPath: string): Promise<boolean> {
        try {
            await fs.access(lockPath);
            return true;
        } catch {
            return false;
        }
    }

    private publicHolder(record: ApplyLockRecord): Partial<ApplyLockRecord> {
        return {
            version: record.version,
            targetId: record.targetId,
            targetHost: record.targetHost,
            scope: record.scope,
            ownerPid: record.ownerPid,
            ownerHost: record.ownerHost,
            acquiredAt: record.acquiredAt,
            expiresAt: record.expiresAt
        };
    }
}
