import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getErrorMessage, getErrorStderr } from '../utils/ErrorUtils';
import { FileLease } from '../utils/FileLease';
import { Logger } from '../utils/Logger';
import { GitConfigOperationOptions } from './GitConfigTypes';
import { GIT_CONFIG_MUTEX_STALE_MS, GIT_CONFIG_MUTEX_TIMEOUT_MS } from './ConfigCommandTimeouts';

export const GIT_CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;

/** Exported so tests can inspect the lock this module actually uses. */
export const GIT_CONFIG_MUTEX_PATH = path.join(os.tmpdir(), 'otak-proxy.gitconfig.mutex');

const MUTEX_STALE_MS = GIT_CONFIG_MUTEX_STALE_MS;
const MUTEX_RETRY_DELAY_MS = 25;

/*
 * One Git write runs several sequential `git config` invocations, so a holder
 * can legitimately stay inside the critical section past the stale window. With
 * an anonymous lock file that made the holder delete its successor's lock on the
 * way out and let a third writer in (#73); the lease keeps the lock owned and
 * refreshed for as long as this process is alive.
 */
const gitConfigLease = new FileLease({
    lockPath: GIT_CONFIG_MUTEX_PATH,
    leaseMs: MUTEX_STALE_MS,
    acquireTimeoutMs: GIT_CONFIG_MUTEX_TIMEOUT_MS,
    retryDelayMs: MUTEX_RETRY_DELAY_MS,
    name: 'Git config mutex'
});

export async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

export async function withGitConfigWriteMutex<T>(
    fn: () => Promise<T>,
    options?: GitConfigOperationOptions
): Promise<T> {
    return gitConfigLease.run(fn, {
        onWaiting: () => options?.onStatus?.('progress.gitConfigWaiting')
    });
}

export function isGitConfigLockError(error: unknown): boolean {
    const message = getErrorMessage(error);
    const stderr = getErrorStderr(error);
    const text = `${message}\n${stderr}`.toLowerCase();
    return text.includes('could not lock config file') ||
        (text.includes('unable to create') && text.includes('.lock'));
}

export function isGitConfigMutexTimeout(error: unknown): boolean {
    return getErrorMessage(error).toLowerCase().includes('timed out acquiring git config mutex');
}

export function getLockedConfigPath(error: unknown): string | null {
    const message = getErrorMessage(error);
    const stderr = getErrorStderr(error);
    const text = `${stderr}\n${message}`;
    const match = text.match(/could not lock config file\s+['"]?(.*?)(?::\s)/i);

    if (!match) {
        return null;
    }

    const raw = match[1].trim();
    return raw.replace(/^['"]/, '').replace(/['"]$/, '');
}

export function tryRemoveStaleGitConfigLock(error: unknown): void {
    const lockedConfigPath = getLockedConfigPath(error);
    if (!lockedConfigPath) {
        return;
    }

    const lockPath = `${normalizeConfigPathToFsPath(lockedConfigPath)}.lock`;
    tryRemoveStaleLockFile(lockPath);
}

function tryRemoveStaleLockFile(lockPath: string): void {
    try {
        if (!fs.existsSync(lockPath) || !isStaleLockFile(lockPath)) {
            return;
        }

        fs.unlinkSync(lockPath);
        Logger.warn(`Removed stale git config lock: ${lockPath}`);
    } catch (error) {
        Logger.warn('Failed to remove stale git config lock:', error);
    }
}

function normalizeConfigPathToFsPath(p: string): string {
    return /^[A-Za-z]:\//.test(p) ? p.replace(/\//g, '\\') : p;
}

/**
 * Staleness of git's *own* `.lock` file, which git writes and this extension
 * only ever cleans up after. It carries no owner, so mtime is all there is.
 */
function isStaleLockFile(lockPath: string): boolean {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > MUTEX_STALE_MS;
}
