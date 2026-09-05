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

export type { GitConfigOperationOptions, GitProxyKey, OperationResult } from './GitConfigTypes';
export const GIT_CONFIG_COMMAND_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS;

export const GIT_ROUTING_PROXY_KEY: GitProxyKey = 'http.proxy';
export const GIT_LEGACY_NON_ROUTING_PROXY_KEY: GitProxyKey = 'https.proxy';
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
 * git config value-pattern is a POSIX regex. Anchor and escape so an owned
 * URL is matched literally, not as a wildcard.
 */
export function exactGitConfigValuePattern(value: string): string {
    return `^${value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
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
     * Sets the Git routing proxy. Git's HTTP stack uses only `http.proxy` for
     * both HTTP and HTTPS remotes (HTTPS uses CONNECT). `https.proxy` is not a
     * routing plane and is not written here; Off still unsets leftover values.
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string, options?: GitConfigOperationOptions): Promise<OperationResult> {
        try {
            await withGitConfigWriteMutex(async () => {
                const snapshot = await this.readProxySnapshot();
                const written: GitProxyKey[] = [];
                try {
                    await this.execGitConfigWithRetry(
                        ['config', '--global', '--replace-all', GIT_ROUTING_PROXY_KEY, url],
                        options
                    );
                    written.push(GIT_ROUTING_PROXY_KEY);
                    await this.assertWrittenValues(url, written);
                } catch (error) {
                    if (written.length === 0) {
                        throw error;
                    }
                    const compensation = await this.compensatePartialSet(written, url, snapshot, options);
                    compensation.summary = summarizePartialWriteCompensation(GIT_ROUTING_PROXY_KEY, compensation);
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
            const preservedKeys: GitProxyKey[] = [];
            await withGitConfigWriteMutex(async () => {
                const expectedValues = options?.expectedValues;
                for (const key of keys) {
                    const exact = options?.exactValues?.[key];
                    const expected = expectedValues?.[key];
                    const ownedValues = exact && exact.length > 0
                        ? [...exact]
                        : expected !== undefined
                            ? [expected]
                            : undefined;
                    if (ownedValues) {
                        for (const value of ownedValues) {
                            const result = await this.unsetOwnedGitValue(key, value, options);
                            if (result.preserved) {
                                preservedKeys.push(key);
                            }
                        }
                        continue;
                    }

                    await this.unsetOneKey(key, options);
                }
                await this.assertUnsetPostCondition(keys, options);
            }, options);

            return preservedKeys.length > 0
                ? { success: true, preservedKeys }
                : { success: true };
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
            const expected = options?.expectedValues?.[key];
            const managed = exact && exact.length > 0
                ? [...exact]
                : expected !== undefined
                    ? [expected]
                    : undefined;
            if (managed) {
                if (managed.some(value => remaining.includes(value))) {
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
     * Value-specific delete. Git can remove only lines matching the owned value.
     *
     * Non-guarantee: if an external writer replaces the value in the same
     * instant as `git config --unset-all` rewrites the file, Git's own
     * last-writer-wins apply. otak-proxy locks cannot serialize those writers.
     */
    private async unsetOwnedGitValue(
        key: GitProxyKey,
        expected: string,
        options?: GitConfigOperationOptions
    ): Promise<{ preserved: boolean }> {
        const readValues = async (): Promise<string[] | undefined> => {
            const inspection = await this.inspectProxy();
            if (inspection.status !== 'available') {
                return undefined;
            }
            if (inspection.allValues?.[key]) {
                return inspection.allValues[key];
            }
            const single = inspection.values?.[key];
            return single ? [single] : [];
        };

        const before = await readValues();
        if (!before) {
            throw new GitConfigUnsetError('Git proxy re-read failed; refusing to unset');
        }
        if (!before.includes(expected)) {
            return { preserved: before.length > 0 };
        }

        try {
            await this.unsetExactValue(key, expected, options);
        } catch (error) {
            const remaining = await readValues();
            if (!remaining) {
                throw new GitConfigUnsetError('Git proxy re-read failed; refusing to unset');
            }
            if (isGitExitCode(error, 5) && !remaining.includes(expected)) {
                return { preserved: remaining.length > 0 };
            }
            throw error;
        }

        const after = await readValues();
        if (!after) {
            throw new GitConfigUnsetError('Git proxy re-read failed; refusing to unset');
        }
        if (after.includes(expected)) {
            throw new GitConfigUnsetError('Git owned proxy value remained after unset');
        }
        return { preserved: after.length > 0 };
    }

    /**
     * Gets the Git routing proxy (`http.proxy` only).
     * A leftover `https.proxy` is not treated as a configured routing plane.
     */
    async getProxy(): Promise<string | null> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return null;
        }
        return inspection.values[GIT_ROUTING_PROXY_KEY];
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
                await this.execGitConfigWithRetry(['config', '--global', '--replace-all', key, previous], options);
            },
            clear: async key => {
                try {
                    await this.unsetExactValue(key, url, options);
                } catch (error) {
                    const remaining = await this.readAllValues(key);
                    if (remaining.length === 0 && isGitExitCode(error, 5)) {
                        return;
                    }
                    throw error;
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
