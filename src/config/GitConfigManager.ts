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
    PartialWriteCompensation,
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
    /**
     * Invoked with the pid of a command the runner had to kill. Production
     * kills the whole process tree on Windows (see `killGitProcessTree`);
     * tests inject a recorder to observe the contract without real processes.
     */
    processTreeKiller?: GitProcessTreeKiller;
    /**
     * The process the default runner starts: `execFile` in production. A
     * test injects a fake child — a promise that settles when the test says
     * so, carrying a `child` with a pid like `promisify(execFile)` returns —
     * so the timeout/tree-kill contract is exercised deterministically
     * instead of racing a real `git` against a deadline.
     */
    commandSpawner?: GitCommandSpawner;
}

export type GitProcessTreeKiller = (pid: number | undefined) => Promise<void>;

export type GitCommandSpawner = (
    command: string,
    args: string[],
    execOptions: Omit<GitCommandOptions, 'timeout'>
) => Promise<{ stdout: string; stderr: string }>;

const TASKKILL_TIMEOUT_MS = 5000;

/**
 * A timed-out command must not leave survivors (#138). On Windows the `git`
 * on PATH is usually Git for Windows' `cmd\git.exe` wrapper; killing it
 * leaves the real `git.exe` child running, still able to write .gitconfig and
 * hold `.gitconfig.lock` after the caller has moved on. `taskkill /T` takes
 * the whole tree down. The kill is bounded and its own failure is only
 * logged: the original timeout is the error that matters.
 */
const killGitProcessTree: GitProcessTreeKiller = async pid => {
    if (pid === undefined || process.platform !== 'win32') {
        return;
    }
    try {
        // A dead pid means the kill already cascaded (job object) — nothing
        // to do, and no "not found" warning to log.
        process.kill(pid, 0);
    } catch {
        return;
    }
    try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            timeout: TASKKILL_TIMEOUT_MS,
            encoding: 'utf8'
        });
    } catch (error) {
        Logger.warn(`taskkill /PID ${pid} /T /F failed after a Git command timeout:`, getErrorMessage(error));
    }
};

const defaultCommandRunnerImpl = async (
    command: string,
    args: string[],
    options: GitCommandOptions,
    killProcessTree: GitProcessTreeKiller,
    spawn: GitCommandSpawner = execFileAsync
): Promise<{ stdout: string; stderr: string }> => {
    // execFile's own timeout kills only the direct child — on Windows that is
    // the cmd\git.exe wrapper, and the real git.exe keeps running (#138). The
    // tree kill has to happen while the wrapper is still alive, so the
    // timeout is implemented here instead: on expiry the whole tree goes down
    // and the rejection carries the same shape execFile's timeout produces
    // (killed + SIGTERM), which every downstream classifier already reads.
    const { timeout: timeoutMs, ...execOptions } = options;
    const pending = spawn(command, args, execOptions);
    const child = (pending as { child?: { pid?: number; kill?: (signal?: string) => boolean } }).child;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            // The deadline itself decides the outcome: reject before the
            // tree cleanup starts, so a command that exits while taskkill
            // is still working cannot win the race back to "success" — which
            // would also skip the timeout-residual accounting. The error
            // shape mirrors an execFile timeout, which every downstream
            // classifier already reads (#138).
            reject(Object.assign(
                new Error(`Command failed: ${command} ${args.join(' ')}\nCommand timed out after ${timeoutMs}ms`),
                { killed: true, signal: 'SIGTERM', code: null, cmd: `${command} ${args.join(' ')}` }
            ));
            // The cleanup still has to run — bounded by the tree killer's
            // own timeout — but its result must not change the outcome, so
            // it is detached and a failure there is only logged.
            void (async () => {
                await killProcessTree(child?.pid);
                // Backstop for the direct child itself: on POSIX the tree
                // killer is a no-op, and even on Windows a process can
                // dodge taskkill.
                child?.kill?.('SIGTERM');
            })().catch(error =>
                Logger.warn('Git command cleanup after a timeout failed:', getErrorMessage(error))
            );
        }, timeoutMs);
    });

    try {
        return await Promise.race([pending, timedOut]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
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
        this.commandRunner = options.commandRunner
            ?? ((command, args, commandOptions) =>
                defaultCommandRunnerImpl(
                    command,
                    args,
                    commandOptions,
                    options.processTreeKiller ?? killGitProcessTree,
                    options.commandSpawner ?? execFileAsync
                ));
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
                        // A timed-out write is not a write that provably did
                        // not happen: the surviving child may still apply it
                        // (#138). Report the key residual so ownership keeps
                        // tracking it for the next cleanup.
                        if (classifyGitConfigError(error, this.timeout).errorType === 'TIMEOUT') {
                            throw this.timeoutResidual(error);
                        }
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

    /**
     * Confirms the value we just wrote is the value Git now reports.
     *
     * This is fail-closed on purpose (#73). Returning early when the config is
     * unreadable, or when the key comes back missing, reports a successful apply
     * for a proxy that was never configured - and because a "successful" apply
     * also records ownership, the next Off would try to clean up a value that is
     * not there. An unverifiable write is a failed write; the compensation path
     * then marks the key residual so ownership tracking still sees it.
     */
    private async assertWrittenValues(url: string, keys: readonly GitProxyKey[]): Promise<void> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            throw new Error('Git proxy write verify failed: config could not be read back');
        }

        const values = inspection.values;
        const missing = keys.filter(key => values[key] === null || values[key] === undefined);
        if (missing.length > 0) {
            throw new Error(`Git proxy write verify failed: ${missing.join(', ')} is not set`);
        }

        const mismatched = keys.filter(key => values[key] !== url);
        if (mismatched.length > 0) {
            throw new Error('Git proxy write verify failed');
        }
    }

    /**
     * Wraps a timed-out write error with the same compensation metadata a
     * partial set carries. No write was recorded as landed, but the killed
     * process (or a surviving child) may have applied it anyway, so the key
     * is residual rather than clean (#138).
     */
    private timeoutResidual(error: unknown): Error {
        const compensation: PartialWriteCompensation<GitProxyKey> = {
            keys: [{ key: GIT_ROUTING_PROXY_KEY, action: 'residual' }],
            residualKeys: [GIT_ROUTING_PROXY_KEY],
            conflictedKeys: [],
            summary: ''
        };
        compensation.summary = summarizePartialWriteCompensation(
            `${GIT_ROUTING_PROXY_KEY} write timed out and may still have landed`,
            compensation
        );
        const wrapped = error instanceof Error ? error : new Error(String(error));
        (wrapped as Error & { otakPartialWrite?: PartialWriteCompensation<GitProxyKey> }).otakPartialWrite = compensation;
        return wrapped;
    }

    private async compensatePartialSet(
        written: readonly GitProxyKey[],
        url: string,
        snapshot: GitProxyValues | undefined,
        options?: GitConfigOperationOptions
    ) {
        return compensatePartialProxyWrite<GitProxyKey>({
            written: written.map(key => ({ key, value: url })),
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
            // Raw execFile errors echo the full command line, including any
            // credential-bearing URL (#108). Mask here so the error is safe to
            // return to every caller (notifications, state, tooltip).
            error: resultSanitizer.maskPassword(classification.error),
            errorType: classification.errorType
        };
    }
}
