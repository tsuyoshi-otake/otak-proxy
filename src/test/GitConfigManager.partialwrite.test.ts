import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { GitCommandRunner, GitConfigManager, GitProxyKey } from '../config/GitConfigManager';

const execFileAsync = promisify(execFile);

const OWNED = 'http://partial.example:8080';
const EXTERNAL = 'http://external.example:8080';
const SECRET = 'http://user:s3cret-token@proxy.example:8080';

function execError(code: number, stderr: string): Error & { code: number; stderr: string } {
    return Object.assign(new Error('Command failed: git config'), { code, stderr });
}

function isGitWrite(args: string[], key: GitProxyKey): boolean {
    return args.includes(key) && !args.includes('--unset') && !args.includes('--get-regexp');
}

function createMemoryGit(options: {
    failHttpsWrite?: boolean;
    externalizeHttpAfterWrite?: boolean;
    failHttpUnset?: boolean;
}): { values: Record<GitProxyKey, string | null>; runner: GitCommandRunner } {
    const values: Record<GitProxyKey, string | null> = {
        'http.proxy': null,
        'https.proxy': null
    };

    const runner: GitCommandRunner = async (_command, args) => {
        if (args.includes('--get-regexp')) {
            const lines: string[] = [];
            if (values['http.proxy']) {
                lines.push(`http.proxy ${values['http.proxy']}`);
            }
            if (values['https.proxy']) {
                lines.push(`https.proxy ${values['https.proxy']}`);
            }
            if (lines.length === 0) {
                throw execError(1, '');
            }
            return { stdout: `${lines.join('\n')}\n`, stderr: '' };
        }

        if (args.includes('--unset')) {
            const key = args.includes('https.proxy') ? 'https.proxy' : 'http.proxy';
            if (options.failHttpUnset && key === 'http.proxy') {
                throw execError(128, 'error: could not unset http.proxy');
            }
            if (!values[key]) {
                throw execError(5, '');
            }
            values[key] = null;
            return { stdout: '', stderr: '' };
        }

        const key: GitProxyKey = args.includes('https.proxy') ? 'https.proxy' : 'http.proxy';
        const value = args[args.length - 1];
        if (options.failHttpsWrite && isGitWrite(args, 'https.proxy')) {
            throw execError(128, 'error: could not write https.proxy');
        }
        values[key] = value;
        if (options.externalizeHttpAfterWrite && key === 'http.proxy') {
            values['http.proxy'] = EXTERNAL;
        }
        return { stdout: '', stderr: '' };
    };

    return { values, runner };
}

function createIsolatedGit(): {
    manager: GitConfigManager;
    inspectRaw: () => Promise<{ http: string | null; https: string | null }>;
    cleanup: () => void;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-git-43-'));
    const gitConfig = path.join(dir, 'gitconfig');
    fs.writeFileSync(gitConfig, '');
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1'
    };

    const runner: GitCommandRunner = async (command, args, options) => {
        if (isGitWrite(args, 'https.proxy')) {
            throw execError(128, 'error: could not write https.proxy');
        }
        return await execFileAsync(command, args, { ...options, env });
    };

    return {
        manager: new GitConfigManager({ commandRunner: runner }),
        inspectRaw: async () => {
            const read = async (key: GitProxyKey): Promise<string | null> => {
                try {
                    const { stdout } = await execFileAsync('git', ['config', '--global', '--get', key], {
                        encoding: 'utf8',
                        timeout: 15000,
                        env
                    });
                    const trimmed = stdout.trim();
                    return trimmed === '' ? null : trimmed;
                } catch {
                    return null;
                }
            };
            return { http: await read('http.proxy'), https: await read('https.proxy') };
        },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
}

suite('GitConfigManager partial multi-key write (#43)', () => {
    test('first write succeeds, second write fails, first value is compensated away', async () => {
        const memory = createMemoryGit({ failHttpsWrite: true });
        const manager = new GitConfigManager({ commandRunner: memory.runner });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values['http.proxy'], null);
        assert.strictEqual(memory.values['https.proxy'], null);
        assert.ok(!result.error || !result.error.includes(OWNED));
    });

    test('does not restore a snapshot over a value an external writer changed', async () => {
        const memory = createMemoryGit({ failHttpsWrite: true, externalizeHttpAfterWrite: true });
        const manager = new GitConfigManager({ commandRunner: memory.runner });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values['http.proxy'], EXTERNAL);
        assert.ok(!result.residualKeys?.includes('http.proxy'));
    });

    test('reports residual keys when compensation cannot remove the written value', async () => {
        const memory = createMemoryGit({ failHttpsWrite: true, failHttpUnset: true });
        const manager = new GitConfigManager({ commandRunner: memory.runner });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values['http.proxy'], OWNED);
        assert.deepStrictEqual(result.residualKeys, ['http.proxy']);
        assert.ok(result.error && result.error.includes('http.proxy'));
        assert.ok(!result.error.includes(OWNED));
    });

    test('redacts credentials from the failed-write error path', async () => {
        const memory = createMemoryGit({ failHttpsWrite: true });
        const manager = new GitConfigManager({ commandRunner: memory.runner });

        const result = await manager.setProxy(SECRET);

        assert.strictEqual(result.success, false);
        assert.ok(!JSON.stringify(result).includes('s3cret-token'));
        assert.ok(!JSON.stringify(result).includes(SECRET));
    });

    test('isolated GIT_CONFIG_GLOBAL: https write failure does not leave http.proxy', async function() {
        const isolated = createIsolatedGit();
        try {
            const result = await isolated.manager.setProxy(OWNED);
            assert.strictEqual(result.success, false);
            const remaining = await isolated.inspectRaw();
            assert.strictEqual(remaining.http, null, 'otak-proxy-written http.proxy must not remain');
            assert.strictEqual(remaining.https, null);
        } finally {
            isolated.cleanup();
        }
    });
});
