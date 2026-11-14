import * as assert from 'assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFakeGitConfig } from './fakeConfigStores';
import {
    GIT_ROUTING_PROXY_KEY,
    GitCommandRunner,
    GitConfigManager,
    GitConfigManagerOptions
} from '../config/GitConfigManager';

const execFileAsync = promisify(execFile);

/**
 * What execFile surfaces when options.timeout expires: the process is killed
 * and the error reports the kill, not an exit code.
 */
function timeoutError(): Error {
    return Object.assign(new Error('Command timed out after 15ms'), {
        killed: true,
        signal: 'SIGTERM',
        code: null
    });
}

suite('Git write timeout (#138)', () => {
    test('a timed-out --replace-all still reports the key as residual', async () => {
        // The command may have written before it was killed: ownership must
        // keep the key so Off can clean it up instead of calling it external.
        const git = createFakeGitConfig();
        const runner: GitCommandRunner = async (_command, args, options) => {
            if (args.includes('--replace-all')) {
                throw timeoutError();
            }
            return git.runner('git', args, options);
        };
        const manager = new GitConfigManager({ commandRunner: runner });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'TIMEOUT');
        assert.deepStrictEqual(result.residualKeys, [GIT_ROUTING_PROXY_KEY]);
    });

    test('a timed-out command kills the process tree so a surviving child cannot write later', async function() {
        // Git for Windows' PATH entry is cmd\git.exe, a wrapper: killing it
        // leaves the real git.exe running and able to write .gitconfig later.
        try {
            await execFileAsync('git', ['--version'], { timeout: 5000 });
        } catch {
            this.skip();
            return;
        }

        const killedPids: Array<number | undefined> = [];
        const options = {
            // 1ms: the spawn cannot possibly finish, so the runner is killed
            // deterministically on any host with git installed.
            timeoutMs: 1,
            processTreeKiller: async (pid: number | undefined) => {
                killedPids.push(pid);
            }
        } as GitConfigManagerOptions;
        const manager = new GitConfigManager(options);

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'TIMEOUT');
        assert.ok(
            killedPids.some(pid => typeof pid === 'number' && pid > 0),
            'the timed-out process pid must be handed to the process-tree killer'
        );
    });

    test('a command that exits during tree cleanup still reports the timeout it exceeded', async function() {
        // The cleanup used to run before the timeout promise rejected, so a
        // process that exited while taskkill was still working won the race
        // back to "success" — and skipped the timeout-residual path (#138).
        try {
            await execFileAsync('git', ['--version'], { timeout: 5000 });
        } catch {
            this.skip();
            return;
        }

        let markCleanupDone: (() => void) | undefined;
        const cleanupDone = new Promise<void>(resolve => { markCleanupDone = resolve; });
        const options = {
            // 1ms: the spawn cannot possibly finish, so the deadline passes
            // deterministically — the question is what the race reports.
            timeoutMs: 1,
            processTreeKiller: async (_pid: number | undefined) => {
                // Slow enough for the command to exit normally mid-cleanup.
                await new Promise(resolve => setTimeout(resolve, 500));
                markCleanupDone?.();
            }
        } as GitConfigManagerOptions;
        const manager = new GitConfigManager(options);

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(
            result.success,
            false,
            'a deadline-exceeded command must not win the race back to success'
        );
        assert.strictEqual(result.errorType, 'TIMEOUT');
        await cleanupDone;
    });
});
