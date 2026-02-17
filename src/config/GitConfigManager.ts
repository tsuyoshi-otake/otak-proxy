import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { getErrorCode, getErrorMessage, getErrorSignal, getErrorStderr, wasProcessKilled } from '../utils/ErrorUtils';

const execFileAsync = promisify(execFile);

/**
 * Result of a Git configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'LOCKED' | 'UNKNOWN';
}

/**
 * Manages Git proxy configuration with secure command execution.
 * Uses execFile() instead of exec() to prevent shell interpretation and command injection.
 */
export class GitConfigManager {
    private readonly timeout: number = 5000; // 5 seconds timeout

    // Cross-process mutex to avoid concurrent writes to the global git config from multiple VS Code windows.
    private static readonly mutexFilePath = path.join(os.tmpdir(), 'otak-proxy.gitconfig.mutex');
    private static readonly MUTEX_TIMEOUT_MS = 5000;
    private static readonly MUTEX_STALE_MS = 30000;
    private static readonly MUTEX_RETRY_DELAY_MS = 25;

    private static async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private static async withWriteMutex<T>(fn: () => Promise<T>): Promise<T> {
        const start = Date.now();

        while (true) {
            try {
                const fd = fs.openSync(GitConfigManager.mutexFilePath, 'wx');
                fs.closeSync(fd);
                break;
            } catch (error) {
                if (getErrorCode(error) !== 'EEXIST') {
                    throw error;
                }

                // Remove stale mutex if a previous process crashed.
                try {
                    const stat = fs.statSync(GitConfigManager.mutexFilePath);
                    if (Date.now() - stat.mtimeMs > GitConfigManager.MUTEX_STALE_MS) {
                        fs.unlinkSync(GitConfigManager.mutexFilePath);
                        continue;
                    }
                } catch {
                    // ignore and retry
                }

                if (Date.now() - start > GitConfigManager.MUTEX_TIMEOUT_MS) {
                    throw new Error('Timed out acquiring Git config mutex');
                }

                await GitConfigManager.sleep(GitConfigManager.MUTEX_RETRY_DELAY_MS);
            }
        }

        try {
            return await fn();
        } finally {
            try {
                fs.unlinkSync(GitConfigManager.mutexFilePath);
            } catch {
                // ignore
            }
        }
    }

    private isGitConfigLockError(error: unknown): boolean {
        const message = getErrorMessage(error);
        const stderr = getErrorStderr(error);
        const text = `${message}\n${stderr}`.toLowerCase();
        return text.includes('could not lock config file') || (text.includes('unable to create') && text.includes('.lock'));
    }

    private normalizeConfigPathToFsPath(p: string): string {
        // git error strings on Windows frequently use forward slashes even for local paths.
        if (/^[A-Za-z]:\//.test(p)) {
            return p.replace(/\//g, '\\');
        }
        return p;
    }

    private tryRemoveStaleGitConfigLock(error: unknown): void {
        const lockedConfigPath = this.getLockedConfigPath(error);
        if (!lockedConfigPath) {
            return;
        }

        const fsConfigPath = this.normalizeConfigPathToFsPath(lockedConfigPath);
        const lockPath = `${fsConfigPath}.lock`;

        try {
            if (!fs.existsSync(lockPath)) {
                return;
            }

            const stat = fs.statSync(lockPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs <= GitConfigManager.MUTEX_STALE_MS) {
                return; // lock is fresh; don't touch it
            }

            fs.unlinkSync(lockPath);
            Logger.warn(`Removed stale git config lock: ${lockPath}`);
        } catch (e) {
            // Best-effort: if we can't stat/unlink, just leave it and let the retry logic fail.
            Logger.warn('Failed to remove stale git config lock:', e);
        }
    }

    private getLockedConfigPath(error: unknown): string | null {
        const message = getErrorMessage(error);
        const stderr = getErrorStderr(error);
        const text = `${stderr}\n${message}`;

        // Example (Windows): "error: could not lock config file C:/Users/.../.gitconfig: File exists"
        // Example (Linux):   "error: could not lock config file '/home/.../.gitconfig': Permission denied"
        const match = text.match(/could not lock config file\s+['"]?(.*?)(?::\s)/i);
        if (!match) {
            return null;
        }

        const raw = match[1].trim();
        return raw.replace(/^['"]/, '').replace(/['"]$/, '');
    }

    private async execGitConfigWithRetry(args: string[]): Promise<void> {
        const maxAttempts = 5;
        let delayMs = 50;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await execFileAsync('git', args, {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
                return;
            } catch (error) {
                if (!this.isGitConfigLockError(error)) {
                    throw error;
                }

                // If we hit a persistent stale lock file, try to remove it once.
                if (attempt === 1) {
                    this.tryRemoveStaleGitConfigLock(error);
                }

                if (attempt === maxAttempts) {
                    throw error;
                }

                // Wait a bit and retry. Lock contention is typically transient when multiple processes
                // try to update the global git config concurrently.
                await GitConfigManager.sleep(delayMs);
                delayMs = Math.min(1000, delayMs * 2);
            }
        }
    }

    /**
     * Sets Git global proxy configuration for both http and https
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            await GitConfigManager.withWriteMutex(async () => {
                // Set http.proxy
                await this.execGitConfigWithRetry(['config', '--global', 'http.proxy', url]);

                // Set https.proxy
                await this.execGitConfigWithRetry(['config', '--global', 'https.proxy', url]);
            });

            return { success: true };
        } catch (error) {
            return this.handleError(error);
        }
    }

    /**
     * Removes Git global proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(): Promise<OperationResult> {
        try {
            await GitConfigManager.withWriteMutex(async () => {
                // Unset http.proxy (git config --unset is idempotent - safe to call even if key doesn't exist)
                try {
                    await this.execGitConfigWithRetry(['config', '--global', '--unset', 'http.proxy']);
                } catch (error) {
                    // Ignore error if key doesn't exist (exit code 5)
                    const code = getErrorCode(error);
                    if (code !== 5 && code !== '5') {
                        throw error;
                    }
                }

                // Unset https.proxy
                try {
                    await this.execGitConfigWithRetry(['config', '--global', '--unset', 'https.proxy']);
                } catch (error) {
                    // Ignore error if key doesn't exist (exit code 5)
                    const code = getErrorCode(error);
                    if (code !== 5 && code !== '5') {
                        throw error;
                    }
                }
            });

            return { success: true };
        } catch (error) {
            return this.handleError(error);
        }
    }

    /**
     * Gets current Git proxy configuration
     * @returns Current proxy URL or null if not configured
     */
    async getProxy(): Promise<string | null> {
        try {
            // Fetch both http.proxy and https.proxy in a single Git invocation to reduce overhead.
            const { stdout } = await execFileAsync('git', ['config', '--global', '--get-regexp', '^(http|https)\\.proxy$'], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            const lines = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);

            const entries = lines
                .map((line) => {
                    const match = line.match(/^([^\s]+)\s+(.+)$/);
                    if (!match) {
                        return null;
                    }
                    return { key: match[1], value: match[2].trim() };
                })
                .filter((e): e is { key: string; value: string } => e !== null);

            const httpProxy = entries.find(e => e.key === 'http.proxy')?.value;
            const httpsProxy = entries.find(e => e.key === 'https.proxy')?.value;

            return (httpProxy || httpsProxy) ? (httpProxy || httpsProxy)! : null;
        } catch (error) {
            // If no matching config exists, git returns exit code 1
            const code = getErrorCode(error);
            if (code === 1 || code === '1') {
                return null;
            }

            // For other errors, log but return null
            Logger.error('Error getting Git proxy:', error);
            return null;
        }
    }

    /**
     * Handles errors from Git command execution and determines error type
     * @param error - Error from execFile
     * @returns OperationResult with error details
     */
    private handleError(error: unknown): OperationResult {
        const errorMessage = getErrorMessage(error);
        const stderr = getErrorStderr(error);
        const code = getErrorCode(error);
        const signal = getErrorSignal(error);
        const killed = wasProcessKilled(error);

        // Determine error type based on error details
        let errorType: OperationResult['errorType'] = 'UNKNOWN';
        let errorDescription = errorMessage;

        // Check for Git not installed
        if (code === 'ENOENT' || errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
            errorType = 'NOT_INSTALLED';
            errorDescription = 'Git is not installed or not in PATH';
        }
        // Check for lock/contended config writes
        else if (this.isGitConfigLockError(error)) {
            errorType = 'LOCKED';

            const lockedConfigPath = this.getLockedConfigPath(error);
            const lockHint = lockedConfigPath
                ? ` (lock: ${lockedConfigPath}.lock)`
                : '';
            errorDescription = `Git config file is locked by another process${lockHint}. ${errorMessage}`;
        }
        // Check for permission errors
        else if (code === 'EACCES' || errorMessage.includes('EACCES') || 
                 stderr.includes('Permission denied') || stderr.includes('permission')) {
            errorType = 'NO_PERMISSION';
            errorDescription = 'Permission denied when accessing Git configuration';
        }
        // Check for timeout
        else if (killed || errorMessage.includes('timeout') || signal === 'SIGTERM') {
            errorType = 'TIMEOUT';
            errorDescription = `Git command timed out after ${this.timeout}ms`;
        }

        return {
            success: false,
            error: errorDescription,
            errorType
        };
    }
}
