import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { getErrorCode, getErrorMessage, getErrorSignal, getErrorStderr, wasProcessKilled } from '../utils/ErrorUtils';
import {
    createNpmNotInstalledError,
    isCommandOnPath,
    resolveNpmInvocation
} from '../utils/NpmInvocation';
import { CONFIG_COMMAND_TIMEOUT_MS } from './ConfigCommandTimeouts';
import { ProxyConfigInspection } from './ProxyConfigInspection';

const execFileAsync = promisify(execFile);

export interface NpmCommandOptions {
    timeout: number;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    windowsHide?: boolean;
}

export type NpmCommandRunner = (
    command: string,
    args: string[],
    options: NpmCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface NpmConfigManagerOptions {
    commandRunner?: NpmCommandRunner;
    isWindows?: boolean;
    env?: NodeJS.ProcessEnv;
    commandAvailable?: (env: NodeJS.ProcessEnv) => boolean;
}

const defaultCommandRunner: NpmCommandRunner = async (command, args, options) => {
    return await execFileAsync(command, args, options);
};

/**
 * npm on Windows starts node + npm-cli.js. Under CPU, disk, or antivirus load
 * that startup can exceed five seconds even when npm is healthy. Keep the
 * timeout bounded, but allow enough scheduler headroom to avoid reporting a
 * transient timeout as a configuration failure.
 */
export const NPM_CONFIG_COMMAND_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS;

interface NpmErrorDetails {
    errorMessage: string;
    stderr: string;
    code: unknown;
    signal: unknown;
    killed: boolean;
}

type NpmErrorClassification = Pick<OperationResult, 'errorType'> & { error: string };
type NpmErrorClassifier = (details: NpmErrorDetails) => NpmErrorClassification | null;

/**
 * Result of an npm configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'CONFIG_ERROR' | 'UNKNOWN';
}

export type NpmProxyKey = 'proxy' | 'https-proxy';
export interface NpmProxyValues {
    proxy: string | null;
    'https-proxy': string | null;
}

function normalizeNpmValue(value: unknown): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    const trimmed = (typeof value === 'string' ? value : String(value)).trim();
    return trimmed === '' || trimmed === 'undefined' || trimmed === 'null' ? null : trimmed;
}

export function classifyNpmConfigError(error: unknown, timeoutMs: number): NpmErrorClassification {
    const details = getNpmErrorDetails(error);
    const classifiers: NpmErrorClassifier[] = [
        classifyNpmMissing,
        classifyNpmPermission,
        data => classifyNpmTimeout(data, timeoutMs),
        classifyNpmConfig
    ];

    for (const classifier of classifiers) {
        const classification = classifier(details);
        if (classification) {
            return classification;
        }
    }

    return { errorType: 'UNKNOWN', error: details.errorMessage };
}

function getNpmErrorDetails(error: unknown): NpmErrorDetails {
    return {
        errorMessage: getErrorMessage(error),
        stderr: getErrorStderr(error),
        code: getErrorCode(error),
        signal: getErrorSignal(error),
        killed: wasProcessKilled(error)
    };
}

function hasMissingExecutableSignal(value: string): boolean {
    const lower = value.toLowerCase();

    return lower.includes('enoent') ||
        lower.includes('not found') ||
        lower.includes('not recognized');
}

function classifyNpmMissing(details: NpmErrorDetails): NpmErrorClassification | null {
    const combinedOutput = `${details.errorMessage}\n${details.stderr}`;
    return details.code === 'ENOENT' ||
        details.code === 9009 ||
        details.code === '9009' ||
        hasMissingExecutableSignal(combinedOutput)
        ? { errorType: 'NOT_INSTALLED', error: 'npm is not installed or not in PATH' }
        : null;
}

function classifyNpmPermission(details: NpmErrorDetails): NpmErrorClassification | null {
    return details.code === 'EACCES' ||
        details.errorMessage.includes('EACCES') ||
        details.stderr.includes('Permission denied') ||
        details.stderr.includes('permission')
        ? { errorType: 'NO_PERMISSION', error: 'Permission denied when accessing npm configuration' }
        : null;
}

function classifyNpmTimeout(details: NpmErrorDetails, timeoutMs: number): NpmErrorClassification | null {
    return details.killed ||
        details.errorMessage.includes('timeout') ||
        details.signal === 'SIGTERM'
        ? { errorType: 'TIMEOUT', error: `npm command timed out after ${timeoutMs}ms` }
        : null;
}

function classifyNpmConfig(details: NpmErrorDetails): NpmErrorClassification | null {
    return details.stderr.includes('config') || details.errorMessage.includes('config')
        ? { errorType: 'CONFIG_ERROR', error: 'Failed to read/write npm configuration' }
        : null;
}

/**
 * Manages npm proxy configuration with secure command execution.
 * Uses execFile() with an argument array. On Windows, npm is a `.cmd` wrapper
 * that cannot be spawned directly (EINVAL) and must not go through `cmd.exe /c`
 * because `%VAR%` expands and `&` splits commands. `resolveNpmInvocation`
 * starts `node` + `npm-cli.js` instead.
 *
 * Note: npm 11.x uses 'proxy' instead of 'http-proxy' for HTTP proxy settings.
 */
export class NpmConfigManager {
    private readonly timeout: number = NPM_CONFIG_COMMAND_TIMEOUT_MS;
    private readonly isWindows: boolean;
    private readonly userConfigPath?: string;
    private readonly commandRunner: NpmCommandRunner;
    private readonly baseEnv: NodeJS.ProcessEnv;
    private readonly commandAvailable: (env: NodeJS.ProcessEnv) => boolean;

    /**
     * @param userConfigPath Optional override for npm user config file (useful for tests).
     */
    constructor(userConfigPath?: string, options: NpmConfigManagerOptions = {}) {
        this.userConfigPath = userConfigPath;
        this.commandRunner = options.commandRunner ?? defaultCommandRunner;
        this.isWindows = options.isWindows ?? process.platform === 'win32';
        this.baseEnv = options.env ?? process.env;
        this.commandAvailable = options.commandAvailable ?? (env => isCommandOnPath('npm', this.isWindows, env));
    }

    private ensureNpmAvailable(env: NodeJS.ProcessEnv): void {
        if (!this.commandAvailable(env)) {
            throw createNpmNotInstalledError();
        }
    }

    /**
     * Executes npm with platform-appropriate options and no shell.
     */
    private async execNpm(args: string[]): Promise<{ stdout: string; stderr: string }> {
        const fullArgs = this.userConfigPath ? ['--userconfig', this.userConfigPath, ...args] : args;

        // npm derives config from environment variables like npm_config_proxy, which can
        // override values stored in npmrc files. In practice these env vars can leak into
        // VS Code test runs (for example via npx), making get/set behavior non-deterministic.
        // We remove them so we can reliably manage and read the persisted npm config.
        const env: NodeJS.ProcessEnv = { ...this.baseEnv };
        delete env.npm_config_proxy;
        delete env.npm_config_https_proxy;
        // Windows env names are case-insensitive, but Node may surface them in different cases.
        delete env.NPM_CONFIG_PROXY;
        delete env.NPM_CONFIG_HTTPS_PROXY;

        this.ensureNpmAvailable(env);
        const invocation = resolveNpmInvocation(fullArgs, { isWindows: this.isWindows, env });
        return this.commandRunner(invocation.command, invocation.args, {
            timeout: this.timeout,
            encoding: 'utf8',
            env,
            ...(this.isWindows ? { windowsHide: true } : {})
        });
    }

    /**
     * Sets npm proxy configuration for both proxy and https-proxy
     * Note: npm 11.x uses 'proxy' (not 'http-proxy') for HTTP proxy
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            // Set proxy (for HTTP - npm 11.x naming)
            await this.execNpm(['config', 'set', 'proxy', url]);

            // Set https-proxy
            await this.execNpm(['config', 'set', 'https-proxy', url]);

            return { success: true };
        } catch (error) {
            return this.handleError(error);
        }
    }

    /**
     * Removes npm proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(): Promise<OperationResult> {
        return this.unsetProxyKeys(['proxy', 'https-proxy']);
    }

    async unsetProxyKeys(keys: readonly NpmProxyKey[]): Promise<OperationResult> {
        try {
            for (const key of keys) {
                // Prefer deleting keys to keep npmrc clean. Deletion is idempotent.
                await this.execNpm(['config', 'delete', key]);
            }

            return { success: true };
        } catch (error) {
            return this.handleError(error);
        }
    }

    /**
     * Gets current npm proxy configuration
     * @returns Current proxy URL or null if not configured
     */
    async getProxy(): Promise<string | null> {
        const inspection = await this.inspectProxy();
        if (inspection.status !== 'available' || !inspection.values) {
            return null;
        }
        return inspection.values.proxy || inspection.values['https-proxy'];
    }

    async inspectProxy(): Promise<ProxyConfigInspection<NpmProxyValues>> {
        try {
            const { stdout: proxyStdout } = await this.execNpm(['config', 'get', 'proxy']);
            const { stdout: httpsProxyStdout } = await this.execNpm(['config', 'get', 'https-proxy']);
            return {
                status: 'available',
                values: {
                    proxy: normalizeNpmValue(proxyStdout),
                    'https-proxy': normalizeNpmValue(httpsProxyStdout)
                }
            };
        } catch (error) {
            const failure = this.handleError(error);
            if (failure.errorType !== 'NOT_INSTALLED') {
                Logger.error('Error getting npm proxy:', error);
            }
            return {
                status: failure.errorType === 'NOT_INSTALLED' ? 'unavailable' : 'error',
                error: failure.error,
                errorType: failure.errorType
            };
        }
    }

    /**
     * Handles errors from npm command execution and determines error type
     * @param error - Error from execFile
     * @returns OperationResult with error details
     */
    private handleError(error: unknown): OperationResult {
        const classification = classifyNpmConfigError(error, this.timeout);

        return {
            success: false,
            error: classification.error,
            errorType: classification.errorType
        };
    }
}
