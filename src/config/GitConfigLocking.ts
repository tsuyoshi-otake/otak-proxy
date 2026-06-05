import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getErrorCode, getErrorMessage, getErrorStderr } from '../utils/ErrorUtils';
import { Logger } from '../utils/Logger';
import { GitConfigOperationOptions } from './GitConfigTypes';

export const GIT_CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400] as const;

const mutexFilePath = path.join(os.tmpdir(), 'otak-proxy.gitconfig.mutex');
const MUTEX_TIMEOUT_MS = 5000;
const MUTEX_STALE_MS = 30000;
const MUTEX_RETRY_DELAY_MS = 25;

export async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
}

export async function withGitConfigWriteMutex<T>(
    fn: () => Promise<T>,
    options?: GitConfigOperationOptions
): Promise<T> {
    await acquireWriteMutex(options);

    try {
        return await fn();
    } finally {
        releaseWriteMutex();
    }
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

function isStaleLockFile(lockPath: string): boolean {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > MUTEX_STALE_MS;
}

async function acquireWriteMutex(options?: GitConfigOperationOptions): Promise<void> {
    const start = Date.now();
    let waitingReported = false;

    while (true) {
        if (tryCreateMutexFile()) {
            return;
        }

        if (removeStaleMutexIfNeeded()) {
            continue;
        }

        if (!waitingReported) {
            options?.onStatus?.('progress.gitConfigWaiting');
            waitingReported = true;
        }

        if (Date.now() - start > MUTEX_TIMEOUT_MS) {
            throw new Error('Timed out acquiring Git config mutex');
        }

        await sleep(MUTEX_RETRY_DELAY_MS);
    }
}

function tryCreateMutexFile(): boolean {
    try {
        const fd = fs.openSync(mutexFilePath, 'wx');
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (getErrorCode(error) === 'EEXIST') {
            return false;
        }

        throw error;
    }
}

function removeStaleMutexIfNeeded(): boolean {
    try {
        const stat = fs.statSync(mutexFilePath);
        if (Date.now() - stat.mtimeMs <= MUTEX_STALE_MS) {
            return false;
        }

        fs.unlinkSync(mutexFilePath);
        return true;
    } catch {
        return false;
    }
}

function releaseWriteMutex(): void {
    try {
        fs.unlinkSync(mutexFilePath);
    } catch {
        // ignore
    }
}
