import * as fs from 'fs';
import * as path from 'path';
import { getErrorStderr } from './ErrorUtils';

export interface NpmInvocation {
    command: string;
    args: string[];
}

export interface NpmInvocationOptions {
    isWindows: boolean;
    env: NodeJS.ProcessEnv;
}

export function getPathEnvValue(env: NodeJS.ProcessEnv): string {
    return env.PATH || env.Path || '';
}

export function getWindowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
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

export function findCommandOnPath(command: string, isWindows: boolean, env: NodeJS.ProcessEnv): string | undefined {
    const pathValue = getPathEnvValue(env);
    if (!pathValue) {
        return undefined;
    }

    const delimiter = isWindows ? ';' : ':';
    const pathEntries = pathValue
        .split(delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);

    for (const entry of pathEntries) {
        for (const candidate of getCommandCandidates(command, isWindows, env)) {
            const candidatePath = path.join(entry, candidate);
            if (canRunCandidate(candidatePath, isWindows)) {
                return candidatePath;
            }
        }
    }

    return undefined;
}

export function isCommandOnPath(command: string, isWindows: boolean, env: NodeJS.ProcessEnv): boolean {
    return findCommandOnPath(command, isWindows, env) !== undefined;
}

export function createNpmNotInstalledError(cause?: unknown): Error & {
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

function findWindowsNpmScript(env: NodeJS.ProcessEnv): string | undefined {
    return findCommandOnPath('npm.cmd', true, env) || findCommandOnPath('npm', true, env);
}

function findNodeExecutable(npmDir: string, env: NodeJS.ProcessEnv): string | undefined {
    const sibling = path.join(npmDir, 'node.exe');
    if (fs.existsSync(sibling)) {
        return sibling;
    }

    const fromPath = findCommandOnPath('node.exe', true, env) || findCommandOnPath('node', true, env);
    if (fromPath) {
        return fromPath;
    }

    const base = path.basename(process.execPath).toLowerCase();
    if (base === 'node.exe' || base === 'node') {
        return process.execPath;
    }

    return undefined;
}

function resolveWindowsNpmCli(env: NodeJS.ProcessEnv): { nodeExe: string; cliJs: string } {
    const npmPath = findWindowsNpmScript(env);
    if (!npmPath) {
        throw createNpmNotInstalledError();
    }

    const cliJs = path.join(path.dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(cliJs)) {
        throw createNpmNotInstalledError();
    }

    const nodeExe = findNodeExecutable(path.dirname(npmPath), env);
    if (!nodeExe) {
        throw createNpmNotInstalledError();
    }

    return { nodeExe, cliJs };
}

/**
 * Resolves an npm invocation that never starts a shell.
 * On Windows, `npm` is a `.cmd` wrapper: `execFile('npm.cmd')` is EINVAL, and
 * `cmd.exe /c` expands `%VAR%` and splits on `&`. Spawn `node` + `npm-cli.js`
 * instead so credentials stay a single argv element.
 */
export function resolveNpmInvocation(npmArgs: string[], options: NpmInvocationOptions): NpmInvocation {
    if (!options.isWindows) {
        return { command: 'npm', args: npmArgs };
    }

    const { nodeExe, cliJs } = resolveWindowsNpmCli(options.env);
    return { command: nodeExe, args: [cliJs, ...npmArgs] };
}
