import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    exactGitConfigValuePattern,
    GitCommandRunner,
    GitConfigManager
} from '../config/GitConfigManager';

const execFileAsync = promisify(execFile);

function commandError(code: number): Error & { code: number } {
    const error = new Error(`git exited ${code}`) as Error & { code: number };
    error.code = code;
    return error;
}

function createInMemoryGit(): {
    store: Record<string, string>;
    calls: string[][];
    runner: GitCommandRunner;
} {
    const store: Record<string, string> = {};
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
        calls.push([...args]);
        const rest = args.slice(2);
        if (rest[0] === '--get-regexp') {
            const lines = Object.entries(store)
                .filter(([key]) => key === 'http.proxy' || key === 'https.proxy')
                .map(([key, value]) => `${key} ${value}`);
            if (lines.length === 0) {
                throw commandError(1);
            }
            return { stdout: `${lines.join('\n')}\n`, stderr: '' };
        }
        if (rest[0] === '--unset' || rest[0] === '--unset-all') {
            const key = rest[1];
            const pattern = rest[2];
            const current = store[key];
            if (!current) {
                throw commandError(5);
            }
            if (pattern && !new RegExp(pattern).test(current)) {
                throw commandError(5);
            }
            delete store[key];
            return { stdout: '', stderr: '' };
        }
        if (rest.length === 2) {
            store[rest[0]] = rest[1];
            return { stdout: '', stderr: '' };
        }
        throw new Error(`unexpected git args: ${args.join(' ')}`);
    };
    return { store, calls, runner };
}

suite('GitConfigManager value-aware unset', () => {
    test('exactGitConfigValuePattern matches only the literal owned URL', () => {
        const owned = 'http://owned.example:8080';
        const pattern = exactGitConfigValuePattern(owned);
        assert.ok(new RegExp(pattern).test(owned));
        assert.ok(!new RegExp(pattern).test('http://external.example:8080'));
        assert.ok(!new RegExp(pattern).test('http://owned.example:8080/extra'));
    });

    test('does not delete a current value that differs from the owned value', async () => {
        const git = createInMemoryGit();
        const manager = new GitConfigManager({ commandRunner: git.runner });
        const owned = 'http://owned.example:8080';
        const external = 'http://external.example:8080';
        git.store['http.proxy'] = owned;

        git.store['http.proxy'] = external;
        const result = await manager.unsetProxyKeys(['http.proxy'], {
            expectedValues: { 'http.proxy': owned }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(git.store['http.proxy'], external);
        assert.ok(result.preservedKeys?.includes('http.proxy'));
        assert.ok(git.calls.every(args => !args.includes('--unset') || args.includes('--unset-all')));
        const valueUnset = git.calls.find(args => args.includes('--unset-all'));
        if (valueUnset) {
            assert.strictEqual(valueUnset[valueUnset.length - 1], exactGitConfigValuePattern(owned));
        }
    });

    test('clears the owned value with --unset-all and a value pattern', async () => {
        const git = createInMemoryGit();
        const manager = new GitConfigManager({ commandRunner: git.runner });
        const owned = 'http://owned.example:8080';
        git.store['http.proxy'] = owned;
        git.store['https.proxy'] = owned;

        const result = await manager.unsetProxyKeys(['http.proxy'], {
            expectedValues: { 'http.proxy': owned }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(git.store['http.proxy'], undefined);
        assert.strictEqual(git.store['https.proxy'], owned);
        const valueUnset = git.calls.find(args => args[2] === '--unset-all');
        assert.ok(valueUnset);
        assert.deepStrictEqual(valueUnset.slice(2), [
            '--unset-all',
            'http.proxy',
            exactGitConfigValuePattern(owned)
        ]);
    });

    test('value-specific unset leaves B when A was owned and B is current at delete time', async () => {
        const git = createInMemoryGit();
        let inspectCount = 0;
        const inner = git.runner;
        const racingRunner: GitCommandRunner = async (command, args, options) => {
            if (args[2] === '--get-regexp') {
                inspectCount += 1;
                const result = await inner(command, args, options);
                if (inspectCount === 1) {
                    git.store['http.proxy'] = 'http://external.example:8080';
                }
                return result;
            }
            return inner(command, args, options);
        };
        const manager = new GitConfigManager({ commandRunner: racingRunner });
        git.store['http.proxy'] = 'http://owned.example:8080';

        const result = await manager.unsetProxyKeys(['http.proxy'], {
            expectedValues: { 'http.proxy': 'http://owned.example:8080' }
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(git.store['http.proxy'], 'http://external.example:8080');
    });

    test('refuses to unset when the pre-delete re-read fails', async () => {
        const runner: GitCommandRunner = async (_command, args) => {
            if (args[2] === '--get-regexp') {
                throw commandError(128);
            }
            throw new Error(`unexpected git args: ${args.join(' ')}`);
        };
        const manager = new GitConfigManager({ commandRunner: runner });
        const result = await manager.unsetProxyKeys(['http.proxy'], {
            expectedValues: { 'http.proxy': 'http://owned.example:8080' }
        });
        assert.strictEqual(result.success, false);
    });

    test('isolated real git: owned A overwritten by B is not deleted', async function() {
        this.timeout(30000);
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-git-46-'));
        const isolatedEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_CONFIG_GLOBAL: path.join(tempDir, 'gitconfig'),
            GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1'
        };
        const runner: GitCommandRunner = async (command, args, options) => {
            return await execFileAsync(command, args, { ...options, env: isolatedEnv });
        };
        const owned = 'http://owned.example:8080';
        const external = 'http://external.example:8080';
        const manager = new GitConfigManager({ commandRunner: runner });
        try {
            const setResult = await manager.setProxy(owned);
            if (!setResult.success && setResult.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(setResult.success, true, setResult.error);

            await execFileAsync('git', ['config', '--global', 'http.proxy', external], {
                timeout: 15000,
                encoding: 'utf8',
                env: isolatedEnv
            });
            await execFileAsync('git', ['config', '--global', 'https.proxy', external], {
                timeout: 15000,
                encoding: 'utf8',
                env: isolatedEnv
            });

            const unsetResult = await manager.unsetProxyKeys(['http.proxy', 'https.proxy'], {
                expectedValues: { 'http.proxy': owned, 'https.proxy': owned }
            });
            assert.strictEqual(unsetResult.success, true, unsetResult.error);

            const after = await manager.inspectProxy();
            assert.strictEqual(after.status, 'available');
            assert.deepStrictEqual(after.values, {
                'http.proxy': external,
                'https.proxy': external
            });
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
