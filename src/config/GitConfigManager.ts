import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { getErrorCode } from '../utils/ErrorUtils';
import { classifyGitConfigError } from './GitConfigErrorClassifier';
import {
    GIT_CONFIG_LOCK_RETRY_DELAYS_MS,
    isGitConfigLockError,
    sleep,
    tryRemoveStaleGitConfigLock,
    withGitConfigWriteMutex
} from './GitConfigLocking';
import { GitConfigOperationOptions, OperationResult } from './GitConfigTypes';
import { CONFIG_COMMAND_TIMEOUT_MS } from './ConfigCommandTimeouts';
import { ProxyConfigInspection } from './ProxyConfigInspection';
import {
    compensatePartialProxyWrite,
    getPartialWriteCompensation,
    summarizePartialWriteCompensation,
    UNREADABLE
} from './PartialProxyWriteCompensation';
import { InputSanitizer } from '../validation/InputSanitizer';

const resultSanitizer = new InputSanitizer();

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
    timeout: number;
    encoding: 'utf8';
}

export type GitCommandRunner = (
    command: string,
    args: string[],
    options: GitCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface GitConfigManagerOptions {
    commandRunner?: GitCommandRunner;
    timeoutMs?: number;
}

const defaultCommandRunner: GitCommandRunner = async (command, args, options) => {
    return await execFileAsync(command, args, options);
};

export type { GitConfigOperationOptions, OperationResult } from './GitConfigTypes';
export const GIT_CONFIG_COMMAND_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS;

export type GitProxyKey = 'http.proxy' | 'https.proxy';
export interface GitProxyValues {
    'http.proxy': string | null;
    'https.proxy': string | null;
}

/**
 * Manages Git proxy configuration with secure command execution.
 * Uses execFile() instead of exec() to prevent shell interpretation and command injection.
 */
export class GitConfigManager {
    private readonly timeout: number;
    private readonly commandRunner: GitCommandRunner;

    constructor(options: GitConfigManagerOptions = {}) {
        this.timeout = options.timeoutMs ?? GIT_CONFIG_COMMAND_TIMEOUT_MS;
        this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    }

    private async execGitConfigWithRetry(args: string[], options?: GitConfigOperationOptions): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.commandRunner('git', args, {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
                return;
            } catch (error) {
                if (!isGitConfigLockError(error)) {
                    throw error;
                }

                // If we hit a persistent stale lock file, try to remove it once.
                if (attempt === 0) {
                    tryRemoveStaleGitConfigLock(error);
                }

                const delayMs = GIT_CONFIG_LOCK_RETRY_DELAYS_MS[attempt];
                if (delayMs === undefined) {
                    throw error;
                }

                // Wait a bit and retry. Lock contention is typically transient when multiple processes
                // try to update the global git config concurrently.
                options?.onStatus?.('progress.gitConfigRetrying');
                await sleep(delayMs);
            }
        }
    }

    /**
     * Sets Git global proxy configuration for both http and https
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string, options?: GitConfigOperationOptions): Promise<OperationResult> {
        try {
            await withGitConfigWriteMutex(async () => {
                const snapshot = await this.readProxySnapshot();
                const written: GitProxyKey[] = [];
                try {
                    await this.execGitConfigWithRetry(['config', '--global', 'http.proxy', url], options);
                    written.push('http.proxy');
                    await this.execGitConfigWithRetry(['config', '--global', 'https.proxy', url], options);
                    written.push('https.proxy');
                    await this.assertWrittenValues(url, written);
                } catch (error) {
                    if (written.length === 0) {
                        throw error;
                    }
                    const failedKey = written.includes('https.proxy') ? undefined : 'https.proxy';
                    const compensation = await this.compensatePartialSet(written, url, snapshot, options);
                    compensation.summary = summarizePartialWriteCompensation(failedKey, compensation);
                    const wrapped = error instanceof Error ? error : new Error(String(error));
                    (wrapped as Error & { otakPartialWrite: typeof compensation }).otakPartialWrite = compensation;
                    throw wrapped;
                }
            }, options);

            return { success: true };
        } catch (error) {
            return this.handleSetFailure(error);
        }
    }

    /**
     * Removes Git global proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(options?: GitConfigOperationOptions): Promise<OperationResult> {
        return this.unsetProxyKeys(['http.proxy', 'https.proxy'], options);
    }

    async unsetProxyKeys(keys: readonly GitProxyKey[], options?: GitConfigOperationOptions): Promise<OperationResult> {
        try {
            await withGitConfigWriteMutex(async () => {
                for (const key of keys) {
                    try {
                        await this.execGitConfigWithRetry(['config', '--global', '--unset', key], options);
                    } catch (error) {
                        // Missing keys are already converged.
                        const code = getErrorCode(error);
                        if (code !== 5 && code !== '5') {
                            throw error;
                        }
                    }
                }
            }, options);

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
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return null;
        }
        return inspection.values['http.proxy'] || inspection.values['https.proxy'];
    }

    async inspectProxy(): Promise<ProxyConfigInspection<GitProxyValues>> {
        try {
            // Fetch both http.proxy and https.proxy in a single Git invocation to reduce overhead.
            const { stdout } = await this.commandRunner('git', ['config', '--global', '--get-regexp', '^(http|https)\\.proxy$'], {
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

            return {
                status: 'available',
                values: {
                    'http.proxy': httpProxy || null,
                    'https.proxy': httpsProxy || null
                }
            };
        } catch (error) {
            // If no matching config exists, git returns exit code 1
            const code = getErrorCode(error);
            if (code === 1 || code === '1') {
                return {
                    status: 'available',
                    values: { 'http.proxy': null, 'https.proxy': null }
                };
            }

            const failure = this.handleError(error);
            if (failure.errorType !== 'NOT_INSTALLED') {
                Logger.error('Error getting Git proxy:', error);
            }
            return {
                status: failure.errorType === 'NOT_INSTALLED' ? 'unavailable' : 'error',
                error: failure.error,
                errorType: failure.errorType
            };
        }
    }

    private async readProxySnapshot(): Promise<GitProxyValues | undefined> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return undefined;
        }
        return inspection.values;
    }

    private async readCurrentProxyValue(key: GitProxyKey): Promise<string | null | typeof UNREADABLE> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return UNREADABLE;
        }
        return inspection.values[key];
    }

    private async assertWrittenValues(url: string, keys: readonly GitProxyKey[]): Promise<void> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return;
        }
        const observed = keys.filter(key => inspection.values?.[key] !== null && inspection.values?.[key] !== undefined);
        if (observed.length === 0) {
            return;
        }
        const mismatched = keys.filter(key => inspection.values?.[key] !== url);
        if (mismatched.length > 0) {
            throw new Error('Git proxy write verify failed');
        }
    }

    private async compensatePartialSet(
        written: readonly GitProxyKey[],
        url: string,
        snapshot: GitProxyValues | undefined,
        options?: GitConfigOperationOptions
    ) {
        return compensatePartialProxyWrite<GitProxyKey>({
            writtenKeys: written,
            writtenValue: url,
            snapshot,
            readCurrent: key => this.readCurrentProxyValue(key),
            restore: async (key, previous) => {
                await this.execGitConfigWithRetry(['config', '--global', key, previous], options);
            },
            clear: async key => {
                try {
                    await this.execGitConfigWithRetry(['config', '--global', '--unset', key], options);
                } catch (error) {
                    const code = getErrorCode(error);
                    if (code !== 5 && code !== '5') {
                        throw error;
                    }
                }
            }
        });
    }

    private handleSetFailure(error: unknown): OperationResult {
        const failure = this.handleError(error);
        const compensation = getPartialWriteCompensation<GitProxyKey>(error);
        if (!compensation) {
            return failure;
        }
        const errorText = [failure.error, compensation.summary].filter(Boolean).join('; ');
        Logger.warn(`Git partial write compensation: ${compensation.summary}`);
        return {
            ...failure,
            error: resultSanitizer.maskPassword(errorText),
            residualKeys: compensation.residualKeys.length > 0 ? compensation.residualKeys : undefined
        };
    }

    /**
     * Handles errors from Git command execution and determines error type
     * @param error - Error from execFile
     * @returns OperationResult with error details
     */
    private handleError(error: unknown): OperationResult {
        const classification = classifyGitConfigError(error, this.timeout);

        return {
            success: false,
            error: classification.error,
            errorType: classification.errorType
        };
    }
}
