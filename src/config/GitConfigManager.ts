import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { getErrorCode, getErrorMessage, getErrorStderr } from '../utils/ErrorUtils';
import { classifyGitConfigError } from './GitConfigErrorClassifier';
import {
    GIT_CONFIG_LOCK_RETRY_DELAYS_MS,
    isGitConfigLockError,
    sleep,
    tryRemoveStaleGitConfigLock,
    withGitConfigWriteMutex
} from './GitConfigLocking';
import { GitConfigOperationOptions, GitProxyKey, OperationResult } from './GitConfigTypes';
import { CONFIG_COMMAND_TIMEOUT_MS } from './ConfigCommandTimeouts';
import { ProxyConfigInspection } from './ProxyConfigInspection';

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

export type { GitConfigOperationOptions, GitProxyKey, OperationResult } from './GitConfigTypes';
export const GIT_CONFIG_COMMAND_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS;

export interface GitProxyValues {
    'http.proxy': string | null;
    'https.proxy': string | null;
}

export interface GitProxyInspection extends ProxyConfigInspection<GitProxyValues> {
    allValues?: Record<GitProxyKey, string[]>;
}

class GitConfigUnsetError extends Error {
    readonly errorType = 'CONFIG_ERROR' as const;

    constructor(message: string) {
        super(message);
        this.name = 'GitConfigUnsetError';
    }
}

function isGitExitCode(error: unknown, expected: number): boolean {
    const code = getErrorCode(error);
    return code === expected || code === String(expected);
}

function isGitMultipleValuesError(error: unknown): boolean {
    return /multiple values/i.test(`${getErrorMessage(error)}\n${getErrorStderr(error)}`);
}

function escapeGitValueRegex(value: string): string {
    return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
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
                // Set http.proxy
                await this.execGitConfigWithRetry(['config', '--global', '--replace-all', 'http.proxy', url], options);

                // Set https.proxy
                await this.execGitConfigWithRetry(['config', '--global', '--replace-all', 'https.proxy', url], options);
            }, options);

            return { success: true };
        } catch (error) {
            return this.handleError(error);
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
                    await this.unsetOneKey(key, options);
                }
                await this.assertUnsetPostCondition(keys, options);
            }, options);

            return { success: true };
        } catch (error) {
            if (error instanceof GitConfigUnsetError) {
                return { success: false, error: error.message, errorType: error.errorType };
            }
            return this.handleError(error);
        }
    }

    private async readAllValues(key: GitProxyKey): Promise<string[]> {
        try {
            const { stdout } = await this.commandRunner('git', ['config', '--global', '--get-all', key], {
                timeout: this.timeout,
                encoding: 'utf8'
            });
            return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        } catch (error) {
            if (isGitExitCode(error, 1)) {
                return [];
            }
            throw error;
        }
    }

    private async unsetExactValue(key: GitProxyKey, value: string, options?: GitConfigOperationOptions): Promise<void> {
        await this.execGitConfigWithRetry(
            ['config', '--global', '--unset-all', key, escapeGitValueRegex(value)],
            options
        );
    }

    private async unsetOneKey(key: GitProxyKey, options?: GitConfigOperationOptions): Promise<void> {
        const exact = options?.exactValues?.[key];
        const current = await this.readAllValues(key);

        if (exact && exact.length > 0) {
            for (const value of exact) {
                if (!current.includes(value)) {
                    continue;
                }
                try {
                    await this.unsetExactValue(key, value, options);
                } catch (error) {
                    const remaining = await this.readAllValues(key);
                    if (isGitExitCode(error, 5) && !remaining.includes(value)) {
                        continue;
                    }
                    if (isGitMultipleValuesError(error) && remaining.includes(value)) {
                        throw new GitConfigUnsetError(`Git ${key} still has multiple matching values`);
                    }
                    throw error;
                }
            }
            return;
        }

        if (current.length === 0) {
            return;
        }
        if (current.length > 1) {
            throw new GitConfigUnsetError(`Git ${key} has multiple values; refusing to delete unspecified values`);
        }

        try {
            await this.unsetExactValue(key, current[0], options);
        } catch (error) {
            const remaining = await this.readAllValues(key);
            if (remaining.length === 0 && isGitExitCode(error, 5)) {
                return;
            }
            if (remaining.length > 1 || isGitMultipleValuesError(error)) {
                throw new GitConfigUnsetError(`Git ${key} has multiple values; refusing to delete unspecified values`);
            }
            throw error;
        }
    }

    private async assertUnsetPostCondition(
        keys: readonly GitProxyKey[],
        options?: GitConfigOperationOptions
    ): Promise<void> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available') {
            throw new GitConfigUnsetError('Git proxy inspect failed after cleanup');
        }

        for (const key of keys) {
            const remaining = inspection.allValues?.[key]
                ?? (inspection.values?.[key] ? [inspection.values[key] as string] : []);
            const exact = options?.exactValues?.[key];
            if (exact && exact.length > 0) {
                if (exact.some(value => remaining.includes(value))) {
                    throw new GitConfigUnsetError(`Git ${key} still contains a managed value after cleanup`);
                }
                continue;
            }
            if (remaining.length > 0) {
                throw new GitConfigUnsetError(`Git ${key} still contains a value after cleanup`);
            }
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

    async inspectProxy(): Promise<GitProxyInspection> {
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

            const allValues: Record<GitProxyKey, string[]> = {
                'http.proxy': [],
                'https.proxy': []
            };
            for (const entry of entries) {
                if (entry.key === 'http.proxy' || entry.key === 'https.proxy') {
                    allValues[entry.key].push(entry.value);
                }
            }

            return {
                status: 'available',
                values: {
                    'http.proxy': allValues['http.proxy'][0] ?? null,
                    'https.proxy': allValues['https.proxy'][0] ?? null
                },
                allValues
            };
        } catch (error) {
            // If no matching config exists, git returns exit code 1
            const code = getErrorCode(error);
            if (code === 1 || code === '1') {
                return {
                    status: 'available',
                    values: { 'http.proxy': null, 'https.proxy': null },
                    allValues: { 'http.proxy': [], 'https.proxy': [] }
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
