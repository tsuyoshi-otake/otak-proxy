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
            const unreadableSince = await this.lockModifiedAt(lockPath);
            if (unreadableSince !== undefined) {
                // A peer may be renewing its lease with an in-place write at this
                // exact instant, or be between creating the file and writing it.
                // While the file was touched within one lease, fail closed: it is
                // safer to report contention than to reclaim a live lock.
                if (!(await this.isAbandonedUnreadableLock(lockPath, unreadableSince, ttlMs))) {
                    return { acquired: false, reason: 'held' };
                }
                // Empty or truncated for longer than a whole lease: no live holder
                // writes a lock that long (renew rewrites it every ttl/3), so the
                // writer died mid-write. Reclaim it like an expired lock (#93).
                return this.reclaimAndCreate(lockPath, target, record, 'unreadable');
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

        return this.reclaimAndCreate(lockPath, target, record, this.publicHolder(holder));
    }

    /**
     * Moves a stale lock aside and creates ours. `stale` is the expired holder,
     * or 'unreadable' for an abandoned empty / truncated lock.
     */
    private async reclaimAndCreate(
        lockPath: string,
        target: ApplyLockRequest,
        record: ApplyLockRecord,
        stale: Partial<ApplyLockRecord> | 'unreadable'
    ): Promise<ApplyLockAcquireResult> {
        const held: ApplyLockAcquireResult = stale === 'unreadable'
            ? { acquired: false, reason: 'held' }
            : { acquired: false, reason: 'held', holder: stale };
        const stalePath = `${lockPath}.stale.${process.pid}.${record.token}`;
        try {
            await fs.rename(lockPath, stalePath);
        } catch {
            return held;
        }

        if (stale === 'unreadable' && await this.readLock(stalePath)) {
            // Another window reclaimed the same abandoned file between our
            // check and the rename, and created its own lock: we moved a live
            // lock. Put it back without overwriting and report contention, so
            // the reclaim cannot end with two holders (#93).
            await fs.link(stalePath, lockPath).catch(() => undefined);
            await fs.unlink(stalePath).catch(() => undefined);
            return held;
        }
        await fs.unlink(stalePath).catch(() => undefined);

        const createdAfterStale = await this.tryCreateLock(lockPath, record);
        return createdAfterStale
            ? { acquired: true, handle: { target, token: record.token, path: lockPath } }
            : held;
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
        let file: fs.FileHandle;
        try {
            file = await fs.open(lockPath, 'wx');
        } catch (error) {
            if (isErrno(error, 'EEXIST')) {
                return false;
            }
            throw error;
        }

        try {
            await file.writeFile(JSON.stringify(record), 'utf8');
        } catch (error) {
            // The file is ours but empty or truncated. Remove it so it does not
            // block every window as an unreadable lock, then report the failure
            // as before (#93).
            await file.close().catch(() => undefined);
            await fs.unlink(lockPath).catch(() => undefined);
            throw error;
        }
        await file.close();
        return true;
    }

    private async readLock(lockPath: string): Promise<ApplyLockRecord | undefined> {
        try {
            const raw = await fs.readFile(lockPath, 'utf8');
            return JSON.parse(raw) as ApplyLockRecord;
        } catch {
            return undefined;
        }
    }

    /** The lock file's mtime, or undefined when it no longer exists or cannot be read. */
    private async lockModifiedAt(lockPath: string): Promise<number | undefined> {
        try {
            return (await fs.stat(lockPath)).mtimeMs;
        } catch {
            return undefined;
        }
    }

    /**
     * An unreadable lock carries no expiry, so its mtime is the only evidence of
     * the last write. mtime is wall-clock time, so it is compared with
     * Date.now(), not the injectable record clock. Before reclaiming, re-read to
     * confirm the file is still unreadable and was not touched since the first
     * look: a writer that finished in between makes it a live lock again.
     */
    private async isAbandonedUnreadableLock(lockPath: string, modifiedAt: number, ttlMs: number): Promise<boolean> {
        if (Date.now() - modifiedAt <= ttlMs) {
            return false;
        }
        if (await this.readLock(lockPath)) {
            return false;
        }
        return (await this.lockModifiedAt(lockPath)) === modifiedAt;
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
