/**
 * Post-condition tests for proxy config writes (#73).
 *
 * The external tool exiting 0 is not evidence that the value was persisted.
 * `assertWrittenValues()` exists to prove it was, but it currently returns
 * early both when the re-read is unreadable and when the re-read succeeds and
 * finds nothing - the exact case it is there to catch. These tests pin the
 * post-condition down for git, npm and pip, from both directions:
 *
 * - a write whose value is provably absent afterwards must fail,
 * - a write whose value is provably present must still succeed.
 */

import * as assert from 'assert';
import { GitCommandRunner, GitConfigManager } from '../config/GitConfigManager';
import { NpmCommandRunner, NpmConfigManager } from '../config/NpmConfigManager';
import { PipCommandRunner, PipConfigManager } from '../config/PipConfigManager';

const URL = 'http://verify.example:8080';

function execError(code: number, stderr: string): Error & { code: number; stderr: string } {
    return Object.assign(new Error('Command failed'), { code, stderr });
}

/**
 * A git that accepts every write, reports success, and persists nothing -
 * a write that silently did not take effect.
 */
function createAmnesiacGit(options: { inspectFailure?: Error } = {}): GitCommandRunner {
    return async (_command, args) => {
        const isRead = args.includes('--get-regexp') || args.includes('--get-all');
        if (!isRead) {
            return { stdout: '', stderr: '' };
        }
        if (options.inspectFailure) {
            throw options.inspectFailure;
        }
        // git exits 1 when no key matches: "the config ran fine, nothing is set".
        throw execError(1, '');
    };
}

function createAmnesiacNpm(options: { inspectFailure?: Error } = {}): NpmCommandRunner {
    return async (_command, args) => {
        if (!args.includes('get')) {
            return { stdout: '', stderr: '' };
        }
        if (options.inspectFailure) {
            throw options.inspectFailure;
        }
        // npm prints the literal "null" for an unset key.
        return { stdout: 'null\n', stderr: '' };
    };
}

function createAmnesiacPip(): PipCommandRunner {
    return async (_command, args) => {
        if (!args.includes('get')) {
            return { stdout: '', stderr: '' };
        }
        throw execError(1, 'ERROR: No such key - global.proxy');
    };
}

function createFaithfulGit(): GitCommandRunner {
    let stored: string | null = null;
    return async (_command, args) => {
        if (args.includes('--get-regexp')) {
            if (!stored) {
                throw execError(1, '');
            }
            return { stdout: `http.proxy ${stored}\n`, stderr: '' };
        }
        if (args.includes('--get-all')) {
            if (!stored) {
                throw execError(1, '');
            }
            return { stdout: `${stored}\n`, stderr: '' };
        }
        if (args.includes('--unset') || args.includes('--unset-all')) {
            stored = null;
            return { stdout: '', stderr: '' };
        }
        stored = args[args.length - 1];
        return { stdout: '', stderr: '' };
    };
}

function createFaithfulNpm(): NpmCommandRunner {
    const stored: Record<string, string | null> = { proxy: null, 'https-proxy': null };
    return async (_command, args) => {
        const key = args.includes('https-proxy') ? 'https-proxy' : 'proxy';
        if (args.includes('get')) {
            return { stdout: `${stored[key] ?? 'null'}\n`, stderr: '' };
        }
        if (args.includes('delete')) {
            stored[key] = null;
            return { stdout: '', stderr: '' };
        }
        stored[key] = args[args.length - 1];
        return { stdout: '', stderr: '' };
    };
}

function npmManager(runner: NpmCommandRunner): NpmConfigManager {
    return new NpmConfigManager(undefined, {
        commandRunner: runner,
        isWindows: false,
        env: {},
        commandAvailable: () => true
    });
}

function pipManager(runner: PipCommandRunner): PipConfigManager {
    return new PipConfigManager({
        commandRunner: runner,
        candidates: [{ command: 'python', argsPrefix: ['-m', 'pip'] }]
    });
}

suite('Proxy write post-conditions (#73)', () => {
    suite('Git', () => {
        test('fails when the re-read proves the value was not written', async () => {
            const manager = new GitConfigManager({ commandRunner: createAmnesiacGit() });

            const result = await manager.setProxy(URL);

            assert.strictEqual(
                result.success,
                false,
                'a write whose value is absent on re-read must not report success'
            );
        });

        test('fails when the write cannot be verified at all', async () => {
            const manager = new GitConfigManager({
                commandRunner: createAmnesiacGit({
                    inspectFailure: execError(128, 'fatal: bad config line 3 in file .gitconfig')
                })
            });

            const result = await manager.setProxy(URL);

            assert.strictEqual(
                result.success,
                false,
                'an unverifiable write must not report success'
            );
            assert.deepStrictEqual(
                result.residualKeys,
                ['http.proxy'],
                'an unverifiable write must still be tracked as possibly residual'
            );
        });

        test('still succeeds when the value is actually there', async () => {
            const manager = new GitConfigManager({ commandRunner: createFaithfulGit() });

            const result = await manager.setProxy(URL);

            assert.strictEqual(result.success, true, result.error);
        });
    });

    suite('npm', () => {
        test('fails when the re-read proves the value was not written', async () => {
            const result = await npmManager(createAmnesiacNpm()).setProxy(URL);

            assert.strictEqual(
                result.success,
                false,
                'a write whose value is absent on re-read must not report success'
            );
        });

        test('fails when the write cannot be verified at all', async () => {
            const result = await npmManager(createAmnesiacNpm({
                inspectFailure: execError(1, 'npm ERR! code EACCES')
            })).setProxy(URL);

            assert.strictEqual(
                result.success,
                false,
                'an unverifiable write must not report success'
            );
        });

        test('still succeeds when the values are actually there', async () => {
            const result = await npmManager(createFaithfulNpm()).setProxy(URL);

            assert.strictEqual(result.success, true, result.error);
        });
    });

    suite('pip', () => {
        test('fails when the re-read proves the value was not written', async () => {
            const result = await pipManager(createAmnesiacPip()).setProxy(URL);

            assert.strictEqual(
                result.success,
                false,
                'a write whose value is absent on re-read must not report success'
            );
        });

        test('still succeeds when the value is actually there', async () => {
            let stored: string | null = null;
            const runner: PipCommandRunner = async (_command, args) => {
                if (args.includes('get')) {
                    if (!stored) {
                        throw execError(1, 'ERROR: No such key - global.proxy');
                    }
                    return { stdout: `${stored}\n`, stderr: '' };
                }
                if (args.includes('unset')) {
                    stored = null;
                    return { stdout: '', stderr: '' };
                }
                stored = args[args.length - 1];
                return { stdout: '', stderr: '' };
            };

            const result = await pipManager(runner).setProxy(URL);

            assert.strictEqual(result.success, true, result.error);
        });
    });
});
