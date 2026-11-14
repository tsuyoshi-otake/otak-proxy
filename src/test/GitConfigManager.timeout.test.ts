import * as assert from 'assert';
import { createFakeGitConfig } from './fakeConfigStores';
import {
    GIT_ROUTING_PROXY_KEY,
    GitCommandRunner,
    GitConfigManager,
    GitConfigManagerOptions
} from '../config/GitConfigManager';

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

    test('a timed-out command kills the process tree so a surviving child cannot write later', async () => {
        // Git for Windows' PATH entry is cmd\git.exe, a wrapper: killing it
        // leaves the real git.exe running and able to write .gitconfig later.
        // The fake child never exits, so the timeout is deterministic on any
        // host — no real git process has to lose a race against the deadline.
        const killedPids: Array<number | undefined> = [];
        const killedSignals: Array<string | undefined> = [];
        let markKilled: (() => void) | undefined;
        const killSeen = new Promise<void>(resolve => { markKilled = resolve; });
        const options: GitConfigManagerOptions = {
            timeoutMs: 20,
            processTreeKiller: async (pid: number | undefined) => {
                killedPids.push(pid);
            },
            commandSpawner: (_command, args) => {
                if (!args.includes('--replace-all')) {
                    return Promise.resolve({ stdout: '', stderr: '' });
                }
                const pending = new Promise<{ stdout: string; stderr: string }>(() => {}) as
                    Promise<{ stdout: string; stderr: string }> & {
                        child: { pid: number; kill: (signal?: string) => boolean }
                    };
                pending.child = {
                    pid: 42424,
                    kill: (signal?: string) => {
                        killedSignals.push(signal);
                        markKilled?.();
                        return true;
                    }
                };
                return pending;
            }
        };
        const manager = new GitConfigManager(options);

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'TIMEOUT');
        assert.deepStrictEqual(
            killedPids,
            [42424],
            'the timed-out process pid must be handed to the process-tree killer'
        );
        // The backstop runs after the tree kill inside the detached cleanup:
        // wait for it rather than racing it.
        await killSeen;
        assert.ok(
            killedSignals.includes('SIGTERM'),
            'the direct child still gets the SIGTERM backstop'
        );
    });

    test('a command that exits during tree cleanup still reports the timeout it exceeded', async () => {
        // The cleanup used to run before the timeout promise rejected, so a
        // process that exited while taskkill was still working won the race
        // back to "success" — and skipped the timeout-residual path (#138).
        // The fake child's exit is scheduled, not raced: it resolves after
        // the deadline but before the slow tree kill finishes, every run.
        let markCleanupDone: (() => void) | undefined;
        const cleanupDone = new Promise<void>(resolve => { markCleanupDone = resolve; });
        const options: GitConfigManagerOptions = {
            timeoutMs: 20,
            processTreeKiller: async (_pid: number | undefined) => {
                // Slow enough for the fake command to exit mid-cleanup.
                await new Promise(resolve => setTimeout(resolve, 100));
                markCleanupDone?.();
            },
            commandSpawner: (_command, args) => {
                if (!args.includes('--replace-all')) {
                    return Promise.resolve({ stdout: '', stderr: '' });
                }
                const pending = new Promise<{ stdout: string; stderr: string }>(resolve =>
                    setTimeout(() => resolve({ stdout: '', stderr: '' }), 40)
                ) as Promise<{ stdout: string; stderr: string }> & {
                    child: { pid: number; kill: (signal?: string) => boolean }
                };
                pending.child = { pid: 42425, kill: () => true };
                return pending;
            }
        };
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
