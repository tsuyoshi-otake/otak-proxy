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
        this.baseDir = options.baseDir ?? path.join(os.tmpdir(), 'otak-proxy-v3-locks');
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
            return { acquired: false, reason: 'ioError' };
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
        task: () => Promise<T>
    ): Promise<{ acquired: true; value: T } | { acquired: false; failed: ApplyLockAcquireResult }> {
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
            for (const target of [...targets].sort((a, b) => a.targetId.localeCompare(b.targetId))) {
                const result = await this.tryAcquire(target, ttlMs);
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
