import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

async function execNpmVersion(timeoutMs: number): Promise<void> {
    if (isWindows) {
        const comspec = process.env.ComSpec || 'cmd.exe';
        await execFileAsync(comspec, ['/d', '/s', '/c', 'npm', '--version'], {
            timeout: timeoutMs,
            encoding: 'utf8',
            windowsHide: true
        });
        return;
    }

    await execFileAsync('npm', ['--version'], {
        timeout: timeoutMs,
        encoding: 'utf8'
    });
}

export async function isNpmAvailable(timeoutMs: number = 5000): Promise<boolean> {
    try {
        await execNpmVersion(timeoutMs);
        return true;
    } catch {
        return false;
    }
}

export async function isGitAvailable(timeoutMs: number = 5000): Promise<boolean> {
    try {
        await execFileAsync('git', ['--version'], {
            timeout: timeoutMs,
            encoding: 'utf8'
        });
        return true;
    } catch {
        return false;
    }
}

