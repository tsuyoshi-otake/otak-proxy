import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';
import { CONFIG_COMMAND_TIMEOUT_MS } from './ConfigCommandTimeouts';
import { ProxyConfigInspection } from './ProxyConfigInspection';
import { getErrorCode, getErrorMessage, getErrorSignal, getErrorStderr, wasProcessKilled } from '../utils/ErrorUtils';

const execFileAsync = promisify(execFile);

export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'CONFIG_ERROR' | 'UNKNOWN';
}

interface PipErrorDetails {
    errorMessage: string;
    stderr: string;
    code: unknown;
    signal: unknown;
    killed: boolean;
}

type PipErrorClassification = Pick<OperationResult, 'errorType'> & { error: string };
type PipErrorClassifier = (details: PipErrorDetails) => PipErrorClassification | null;

export interface PipCommandCandidate {
    command: string;
    argsPrefix: string[];
}

interface PipCommandOptions {
    timeout: number;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
}

export type PipCommandRunner = (
    command: string,
    args: string[],
    options: PipCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface PipConfigManagerOptions {
    commandRunner?: PipCommandRunner;
    candidates?: PipCommandCandidate[];
    timeoutMs?: number;
}

export const PIP_CONFIG_COMMAND_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS;

const defaultCommandRunner: PipCommandRunner = async (command, args, options) => {
    return await execFileAsync(command, args, options);
};

function defaultCandidates(isWindows: boolean): PipCommandCandidate[] {
    if (isWindows) {
        return [
            { command: 'py', argsPrefix: ['-m', 'pip'] },
            { command: 'python', argsPrefix: ['-m', 'pip'] },
            { command: 'python3', argsPrefix: ['-m', 'pip'] }
        ];
    }

    return [
        { command: 'python3', argsPrefix: ['-m', 'pip'] },
        { command: 'python', argsPrefix: ['-m', 'pip'] }
    ];
}

export function classifyPipConfigError(error: unknown, timeoutMs: number): PipErrorClassification {
    const details = getPipErrorDetails(error);
    const classifiers: PipErrorClassifier[] = [
        classifyPipMissing,
        classifyPipPermission,
        data => classifyPipTimeout(data, timeoutMs),
        classifyPipConfig
    ];

    for (const classifier of classifiers) {
        const classification = classifier(details);
        if (classification) {
            return classification;
        }
    }

    return { errorType: 'UNKNOWN', error: details.errorMessage };
}

function getPipErrorDetails(error: unknown): PipErrorDetails {
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
        lower.includes('not recognized') ||
        lower.includes('no installed python') ||
        lower.includes('python was not found') ||
        lower.includes('no module named pip');
}

function classifyPipMissing(details: PipErrorDetails): PipErrorClassification | null {
    const combinedOutput = `${details.errorMessage}\n${details.stderr}`;
    return details.code === 'ENOENT' ||
        details.code === 9009 ||
        details.code === '9009' ||
        hasMissingExecutableSignal(combinedOutput)
        ? { errorType: 'NOT_INSTALLED', error: 'pip is not installed or Python is not in PATH' }
        : null;
}

function classifyPipPermission(details: PipErrorDetails): PipErrorClassification | null {
    return details.code === 'EACCES' ||
        details.errorMessage.includes('EACCES') ||
        details.stderr.includes('Permission denied') ||
        details.stderr.includes('permission denied') ||
        details.stderr.includes('Access is denied')
        ? { errorType: 'NO_PERMISSION', error: 'Permission denied when accessing pip configuration' }
        : null;
}

function classifyPipTimeout(details: PipErrorDetails, timeoutMs: number): PipErrorClassification | null {
    return details.killed ||
        details.errorMessage.includes('timeout') ||
        details.signal === 'SIGTERM'
        ? { errorType: 'TIMEOUT', error: `pip command timed out after ${timeoutMs}ms` }
        : null;
}

function classifyPipConfig(details: PipErrorDetails): PipErrorClassification | null {
    return details.stderr.includes('config') ||
        details.errorMessage.includes('config') ||
        details.stderr.includes('ERROR:')
        ? { errorType: 'CONFIG_ERROR', error: 'Failed to read/write pip configuration' }
        : null;
}

function isPipKeyUnsetError(error: unknown): boolean {
    const combinedOutput = `${getErrorMessage(error)}\n${getErrorStderr(error)}`.toLowerCase();
    return combinedOutput.includes('no such key');
}

function normalizePipValue(value: string): string | null {
    const trimmed = value.trim();
    return trimmed && trimmed !== 'undefined' && trimmed !== 'null' ? trimmed : null;
}

function withoutPipConfigEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PIP_PROXY;
    delete env.pip_proxy;
    delete env.PIP_CONFIG_FILE;
    delete env.pip_config_file;
    return env;
}

/**
 * Manages pip proxy configuration through `python -m pip config --user`.
 * The Python executable name varies by platform, so commands are attempted
 * through a small candidate list and missing Python/pip is reported as an
 * optional tool absence.
 */
export class PipConfigManager {
    private readonly timeout: number;
    private readonly candidates: PipCommandCandidate[];
    private readonly commandRunner: PipCommandRunner;

    constructor(options: PipConfigManagerOptions = {}) {
        this.timeout = options.timeoutMs ?? PIP_CONFIG_COMMAND_TIMEOUT_MS;
        this.candidates = options.candidates ?? defaultCandidates(process.platform === 'win32');
        this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    }

    async setProxy(url: string): Promise<OperationResult> {
        try {
            await this.execPip(['config', '--user', 'set', 'global.proxy', url]);
            return { success: true };
        } catch (error) {
            return this.handleError(error);
        }
    }

    async unsetProxy(): Promise<OperationResult> {
        try {
            const currentProxy = await this.readProxy();
            if (currentProxy === null) {
                return { success: true };
            }

            await this.execPip(['config', '--user', 'unset', 'global.proxy']);
            return { success: true };
        } catch (error) {
            if (isPipKeyUnsetError(error)) {
                return { success: true };
            }
            return this.handleError(error);
        }
    }

    async getProxy(): Promise<string | null> {
        const inspection = await this.inspectProxy();
        return inspection.status === 'available' ? inspection.values?.proxy ?? null : null;
    }

    async inspectProxy(): Promise<ProxyConfigInspection<{ proxy: string | null }>> {
        try {
            return {
                status: 'available',
                values: { proxy: await this.readProxy() }
            };
        } catch (error) {
            const failure = this.handleError(error);
            if (!isPipKeyUnsetError(error) && failure.errorType !== 'NOT_INSTALLED') {
                Logger.error('Error getting pip proxy:', error);
            }
            if (isPipKeyUnsetError(error)) {
                return { status: 'available', values: { proxy: null } };
            }
            return {
                status: failure.errorType === 'NOT_INSTALLED' ? 'unavailable' : 'error',
                error: failure.error,
                errorType: failure.errorType
            };
        }
    }

    private async readProxy(): Promise<string | null> {
        try {
            const { stdout } = await this.execPip(['config', '--user', 'get', 'global.proxy']);
            return normalizePipValue(stdout);
        } catch (error) {
            if (isPipKeyUnsetError(error)) {
                return null;
            }
            throw error;
        }
    }

    private async execPip(args: string[]): Promise<{ stdout: string; stderr: string }> {
        let lastMissingError: unknown;

        for (const candidate of this.candidates) {
            try {
                return await this.commandRunner(candidate.command, [...candidate.argsPrefix, ...args], {
                    timeout: this.timeout,
                    encoding: 'utf8',
                    env: withoutPipConfigEnv(),
                    windowsHide: true
                });
            } catch (error) {
                const classification = classifyPipConfigError(error, this.timeout);
                if (classification.errorType === 'NOT_INSTALLED') {
                    lastMissingError = error;
                    continue;
                }

                throw error;
            }
        }

        throw createPipNotInstalledError(lastMissingError);
    }

    private handleError(error: unknown): OperationResult {
        const classification = classifyPipConfigError(error, this.timeout);

        return {
            success: false,
            error: classification.error,
            errorType: classification.errorType
        };
    }
}

function createPipNotInstalledError(cause?: unknown): Error & {
    code?: string;
    stderr?: string;
    cause?: unknown;
} {
    const missingError = new Error('pip is not installed or Python is not in PATH') as Error & {
        code?: string;
        stderr?: string;
        cause?: unknown;
    };
    missingError.code = 'ENOENT';
    missingError.stderr = getErrorStderr(cause);
    missingError.cause = cause;
    return missingError;
}
