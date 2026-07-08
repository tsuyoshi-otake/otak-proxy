import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { getErrorCode, getErrorMessage, getErrorSignal, getErrorStderr, wasProcessKilled } from '../utils/ErrorUtils';

const execFileAsync = promisify(execFile);

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

function getPathEnvValue(env: NodeJS.ProcessEnv): string {
    return env.PATH || env.Path || '';
}

function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
    const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    return raw
        .split(';')
        .map(ext => ext.trim())
        .filter(Boolean);
}

function getCommandCandidates(command: string, isWindows: boolean, env: NodeJS.ProcessEnv): string[] {
    if (!isWindows || path.extname(command)) {
        return [command];
    }

    return [command, ...getWindowsPathExtensions(env).map(ext => `${command}${ext}`)];
}

function canRunCandidate(candidatePath: string, isWindows: boolean): boolean {
    try {
        if (isWindows) {
            return fs.existsSync(candidatePath);
        }

        fs.accessSync(candidatePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function isCommandOnPath(command: string, isWindows: boolean, env: NodeJS.ProcessEnv): boolean {
    const pathValue = getPathEnvValue(env);
    if (!pathValue) {
        return false;
    }

    const delimiter = isWindows ? ';' : ':';
    const pathModule = isWindows ? path.win32 : path.posix;
    const pathEntries = pathValue
        .split(delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);

    return pathEntries.some(entry =>
        getCommandCandidates(command, isWindows, env).some(candidate =>
            canRunCandidate(pathModule.join(entry, candidate), isWindows)
        )
    );
}

function createNpmNotInstalledError(cause?: unknown): Error & {
    code?: string;
    stderr?: string;
    cause?: unknown;
} {
    const missingError = new Error('npm is not installed or not in PATH') as Error & {
        code?: string;
        stderr?: string;
        cause?: unknown;
    };
    missingError.code = 'ENOENT';
    missingError.stderr = getErrorStderr(cause);
    missingError.cause = cause;
    return missingError;
}

/**
 * Manages npm proxy configuration with secure command execution.
 * Uses execFile() directly. On Windows, npm is a batch file (.cmd), so this
 * invokes npm via cmd.exe to avoid relying on `shell: true`.
 * Arguments are passed as an array to avoid unsafe string concatenation.
 * 
 * Note: npm 11.x uses 'proxy' instead of 'http-proxy' for HTTP proxy settings.
 */
export class NpmConfigManager {
    private readonly timeout: number = 5000; // 5 seconds timeout
    private readonly isWindows: boolean = process.platform === 'win32';
    private readonly userConfigPath?: string;

    /**
     * @param userConfigPath Optional override for npm user config file (useful for tests).
     */
    constructor(userConfigPath?: string) {
        this.userConfigPath = userConfigPath;
    }

    private ensureNpmAvailable(env: NodeJS.ProcessEnv): void {
        if (!isCommandOnPath('npm', this.isWindows, env)) {
            throw createNpmNotInstalledError();
        }
    }

    /**
     * Executes npm command with platform-appropriate options.
     * On Windows, npm is a batch file (.cmd). We invoke it via cmd.exe so we don't need `shell: true`.
     */
    private async execNpm(args: string[]): Promise<{ stdout: string; stderr: string }> {
        const fullArgs = this.userConfigPath ? ['--userconfig', this.userConfigPath, ...args] : args;

        // npm derives config from environment variables like npm_config_proxy, which can
        // override values stored in npmrc files. In practice these env vars can leak into
        // VS Code test runs (for example via npx), making get/set behavior non-deterministic.
        // We remove them so we can reliably manage and read the persisted npm config.
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.npm_config_proxy;
        delete env.npm_config_https_proxy;
        // Windows env names are case-insensitive, but Node may surface them in different cases.
        delete env.NPM_CONFIG_PROXY;
        delete env.NPM_CONFIG_HTTPS_PROXY;

        if (this.isWindows) {
            this.ensureNpmAvailable(env);
            const comspec = process.env.ComSpec || 'cmd.exe';
            return execFileAsync(comspec, ['/d', '/s', '/c', 'npm', ...fullArgs], {
                timeout: this.timeout,
                encoding: 'utf8',
                env,
                windowsHide: true
            });
        }

        this.ensureNpmAvailable(env);
        return execFileAsync('npm', fullArgs, {
            timeout: this.timeout,
            encoding: 'utf8',
            env
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
        try {
            // Prefer deleting keys to keep npmrc clean. Deletion is idempotent on modern npm.
            await this.execNpm(['config', 'delete', 'proxy']);
            await this.execNpm(['config', 'delete', 'https-proxy']);

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
        try {
            const normalizeValue = (value: unknown): string | null => {
                if (value === undefined || value === null) {
                    return null;
                }
                const str = typeof value === 'string' ? value : String(value);
                const trimmed = str.trim();
                // npm returns 'null' or 'undefined' as a string when config doesn't exist
                if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') {
                    return null;
                }
                return trimmed;
            };

            // Prefer HTTP proxy setting, but fall back to https-proxy if only that is configured.
            const { stdout: proxyStdout } = await this.execNpm(['config', 'get', 'proxy']);
            const proxy = normalizeValue(proxyStdout);
            if (proxy !== null) {
                return proxy;
            }

            const { stdout: httpsProxyStdout } = await this.execNpm(['config', 'get', 'https-proxy']);
            return normalizeValue(httpsProxyStdout);
        } catch (error) {
            // For errors, log but return null
            Logger.error('Error getting npm proxy:', error);
            return null;
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
