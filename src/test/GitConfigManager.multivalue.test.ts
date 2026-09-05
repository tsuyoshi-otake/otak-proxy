import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { GitCommandRunner, GitConfigManager } from '../config/GitConfigManager';
import { GitConfigOperationOptions } from '../config/GitConfigTypes';

const execFileAsync = promisify(execFile);

const OWNED = 'http://owned.example:8080';
const EXTERNAL = 'http://external.example:8080';
const SECRET = 'http://user:s3cret-token@proxy.example:8080';

function execError(code: number, stderr: string): Error & { code: number; stderr: string } {
    return Object.assign(new Error('Command failed: git config'), { code, stderr });
}

function inspectAllHttp(inspection: { allValues?: Record<string, string[]>; values?: { 'http.proxy': string | null } }): string[] {
    if (inspection.allValues?.['http.proxy']) {
        return inspection.allValues['http.proxy'];
    }
    return inspection.values?.['http.proxy'] ? [inspection.values['http.proxy']] : [];
}

function createIsolatedGit(): {
    manager: GitConfigManager;
    git: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
    cleanup: () => void;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-git-44-'));
    const gitConfig = path.join(dir, 'gitconfig');
    fs.writeFileSync(gitConfig, '');
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1'
    };
    const runner: GitCommandRunner = async (command, args, options) => {
        return await execFileAsync(command, args, { ...options, env });
    };
    return {
        manager: new GitConfigManager({ commandRunner: runner }),
        git: async (args) => {
            try {
                const result = await execFileAsync('git', args, { encoding: 'utf8', timeout: 15000, env });
                return { stdout: result.stdout, stderr: result.stderr, code: 0 };
            } catch (error) {
                const err = error as { stdout?: string; stderr?: string; code?: string | number };
                return {
                    stdout: typeof err.stdout === 'string' ? err.stdout : '',
                    stderr: typeof err.stderr === 'string' ? err.stderr : '',
                    code: typeof err.code === 'number' ? err.code : 1
                };
            }
        },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
}

suite('GitConfigManager multi-value exit 5 (#44)', () => {
    suite('commandRunner classification', () => {
        test('does not treat exit 5 plus multiple-values stderr as missing success', async () => {
            const calls: string[][] = [];
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    calls.push(args);
                    if (args.includes('--get-all')) {
                        return { stdout: 'http://one.example:8080\nhttp://two.example:8080\n', stderr: '' };
                    }
                    if (args.includes('--get-regexp')) {
                        return {
                            stdout: 'http.proxy http://one.example:8080\nhttp.proxy http://two.example:8080\n',
                            stderr: ''
                        };
                    }
                    if (args.includes('--unset') && !args.includes('--unset-all')) {
                        throw execError(5, 'warning: http.proxy has multiple values');
                    }
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.unsetProxyKeys(['http.proxy']);
            assert.strictEqual(result.success, false);
            assert.ok(result.error);
            assert.ok(!/http:\/\/(one|two)\.example/.test(JSON.stringify(result)), 'must not leak proxy URLs in the result');
            assert.ok(
                calls.every(args => !(args.includes('--unset-all') && args.length === 4)),
                'must not issue value-less --unset-all'
            );
        });

        test('treats exit 5 as missing only when inspect shows the key is empty', async () => {
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    if (args.includes('--get-all')) {
                        throw execError(1, '');
                    }
                    if (args.includes('--get-regexp')) {
                        throw execError(1, '');
                    }
                    if (args.includes('--unset')) {
                        throw execError(5, '');
                    }
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.unsetProxyKeys(['http.proxy']);
            assert.strictEqual(result.success, true);
        });

        test('does not claim success when a managed value remains after unset', async () => {
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    if (args.includes('--get-all')) {
                        return { stdout: `${OWNED}\n`, stderr: '' };
                    }
                    if (args.includes('--get-regexp')) {
                        return { stdout: `http.proxy ${OWNED}\n`, stderr: '' };
                    }
                    if (args.includes('--unset') || args.includes('--unset-all')) {
                        return { stdout: '', stderr: '' };
                    }
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.unsetProxyKeys(['http.proxy']);
            assert.strictEqual(result.success, false);
            assert.ok(!JSON.stringify(result).includes('s3cret-token'));
        });

        test('setProxy uses --replace-all so a later write cannot stack a second value', async () => {
            const calls: string[][] = [];
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    calls.push(args);
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.setProxy('http://proxy.example:8080');
            assert.strictEqual(result.success, true);
            assert.ok(calls.some(args =>
                args.includes('--replace-all') &&
                args.includes('http.proxy') &&
                args.includes('http://proxy.example:8080')
            ));
            assert.ok(!calls.some(args => args.includes('--replace-all') && args.includes('https.proxy')));
        });
    });

    suite('real Git + isolated GIT_CONFIG_GLOBAL', () => {
        let isolated: ReturnType<typeof createIsolatedGit>;

        setup(function() {
            isolated = createIsolatedGit();
        });

        teardown(function() {
            isolated.cleanup();
        });

        test('missing --unset equivalent is idempotent success', async function() {
            const missing = await isolated.git(['config', '--global', '--unset', 'http.proxy']);
            if (missing.code !== 5 && missing.code !== 0) {
                this.skip();
                return;
            }

            const result = await isolated.manager.unsetProxyKeys(['http.proxy']);
            assert.strictEqual(result.success, true);
            const after = await isolated.git(['config', '--global', '--get-all', 'http.proxy']);
            assert.ok(after.code === 1 || after.stdout.trim() === '');
        });

        test('single-value unset clears the key and inspect is empty', async function() {
            const add = await isolated.git(['config', '--global', '--add', 'http.proxy', OWNED]);
            if (add.code !== 0) {
                this.skip();
                return;
            }

            const result = await isolated.manager.unsetProxyKeys(['http.proxy']);
            assert.strictEqual(result.success, true, result.error);
            const after = await isolated.git(['config', '--global', '--get-all', 'http.proxy']);
            assert.ok(after.code === 1 || after.stdout.trim() === '');
            const inspection = await isolated.manager.inspectProxy();
            assert.strictEqual(inspection.status, 'available');
            assert.deepStrictEqual(inspectAllHttp(inspection), []);
        });

        test('multi-value --unset is not classified as missing success', async function() {
            const add1 = await isolated.git(['config', '--global', '--add', 'http.proxy', OWNED]);
            const add2 = await isolated.git(['config', '--global', '--add', 'http.proxy', EXTERNAL]);
            if (add1.code !== 0 || add2.code !== 0) {
                this.skip();
                return;
            }

            const rawUnset = await isolated.git(['config', '--global', '--unset', 'http.proxy']);
            assert.strictEqual(rawUnset.code, 5);
            assert.match(rawUnset.stderr, /multiple values/i);
            const stillThere = await isolated.git(['config', '--global', '--get-all', 'http.proxy']);
            assert.deepStrictEqual(stillThere.stdout.trim().split(/\r?\n/), [OWNED, EXTERNAL]);

            const result = await isolated.manager.unsetProxyKeys(['http.proxy']);
            const remaining = (await isolated.git(['config', '--global', '--get-all', 'http.proxy']))
                .stdout.trim().split(/\r?\n/).filter(Boolean);

            if (result.success) {
                assert.deepStrictEqual(remaining, [], 'success requires the key to be empty');
            } else {
                assert.deepStrictEqual(remaining, [OWNED, EXTERNAL], 'unspecified multi-value must not delete external values');
            }

            const inspection = await isolated.manager.inspectProxy();
            assert.strictEqual(inspection.status, 'available');
            assert.deepStrictEqual(inspectAllHttp(inspection).sort(), remaining.slice().sort());
            assert.ok(inspectAllHttp(inspection).length !== 1, 'inspect must not hide a surviving second value');
        });

        test('value-specific cleanup removes only the owned multi-value', async function() {
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', OWNED])).code, 0);
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', EXTERNAL])).code, 0);

            const result = await isolated.manager.unsetProxyKeys(['http.proxy'], {
                exactValues: { 'http.proxy': [OWNED] }
            } as GitConfigOperationOptions);

            assert.strictEqual(result.success, true, result.error);
            const remaining = (await isolated.git(['config', '--global', '--get-all', 'http.proxy']))
                .stdout.trim().split(/\r?\n/).filter(Boolean);
            assert.deepStrictEqual(remaining, [EXTERNAL]);
            const inspection = await isolated.manager.inspectProxy();
            assert.deepStrictEqual(inspectAllHttp(inspection), [EXTERNAL]);
        });

        test('setProxy --replace-all collapses stacked values to one', async function() {
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', EXTERNAL])).code, 0);
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', OWNED])).code, 0);

            const result = await isolated.manager.setProxy(OWNED);
            if (!result.success && result.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(result.success, true, result.error);
            const http = (await isolated.git(['config', '--global', '--get-all', 'http.proxy']))
                .stdout.trim().split(/\r?\n/).filter(Boolean);
            const https = (await isolated.git(['config', '--global', '--get-all', 'https.proxy']))
                .stdout.trim().split(/\r?\n/).filter(Boolean);
            assert.deepStrictEqual(http, [OWNED]);
            assert.deepStrictEqual(https, []);
        });

        test('credential-bearing multi-values do not appear in the operation result', async function() {
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', SECRET])).code, 0);
            assert.strictEqual((await isolated.git(['config', '--global', '--add', 'http.proxy', EXTERNAL])).code, 0);

            const result = await isolated.manager.unsetProxyKeys(['http.proxy']);
            const serialized = JSON.stringify(result);
            assert.ok(!serialized.includes('s3cret-token'));
            assert.ok(!serialized.includes('user:s3cret'));
        });
    });
});
