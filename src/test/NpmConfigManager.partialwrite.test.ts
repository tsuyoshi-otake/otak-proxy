import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { NpmCommandRunner, NpmConfigManager, NpmProxyKey } from '../config/NpmConfigManager';

const execFileAsync = promisify(execFile);

const OWNED = 'http://partial.example:8080';
const EXTERNAL = 'http://external.example:8080';
const SECRET = 'http://user:s3cret-token@proxy.example:8080';

function execError(code: number, stderr: string): Error & { code: number; stderr: string } {
    return Object.assign(new Error('Command failed: npm config'), { code, stderr });
}

function npmKeyFromArgs(args: string[]): NpmProxyKey | undefined {
    if (args.includes('https-proxy')) {
        return 'https-proxy';
    }
    if (args.includes('proxy')) {
        return 'proxy';
    }
    return undefined;
}

function isNpmSet(args: string[]): boolean {
    return args.includes('set') || args.includes('config set');
}

function createMemoryNpm(options: {
    failHttpsWrite?: boolean;
    externalizeProxyAfterWrite?: boolean;
    failProxyDelete?: boolean;
}): { values: Record<NpmProxyKey, string | null>; runner: NpmCommandRunner } {
    const values: Record<NpmProxyKey, string | null> = {
        proxy: null,
        'https-proxy': null
    };

    const runner: NpmCommandRunner = async (_command, args) => {
        const key = npmKeyFromArgs(args);
        if (args.includes('get') && key) {
            return { stdout: `${values[key] ?? 'null'}\n`, stderr: '' };
        }
        if (args.includes('delete') && key) {
            if (options.failProxyDelete && key === 'proxy') {
                throw execError(1, 'error: could not delete proxy');
            }
            values[key] = null;
            return { stdout: '', stderr: '' };
        }
        if (isNpmSet(args) && key) {
            if (options.failHttpsWrite && key === 'https-proxy') {
                throw execError(1, 'error: could not write https-proxy');
            }
            const value = args[args.length - 1];
            values[key] = value;
            if (options.externalizeProxyAfterWrite && key === 'proxy') {
                values.proxy = EXTERNAL;
            }
            return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };

    return { values, runner };
}

suite('NpmConfigManager partial multi-key write (#43)', () => {
    test('first write succeeds, second write fails, first value is compensated away', async () => {
        const memory = createMemoryNpm({ failHttpsWrite: true });
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandRunner: memory.runner,
            commandAvailable: () => true
        });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values.proxy, null);
        assert.strictEqual(memory.values['https-proxy'], null);
        assert.ok(!result.error || !result.error.includes(OWNED));
    });

    test('does not restore a snapshot over a value an external writer changed', async () => {
        const memory = createMemoryNpm({ failHttpsWrite: true, externalizeProxyAfterWrite: true });
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandRunner: memory.runner,
            commandAvailable: () => true
        });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values.proxy, EXTERNAL);
        assert.ok(!result.residualKeys?.includes('proxy'));
    });

    test('reports residual keys when compensation cannot remove the written value', async () => {
        const memory = createMemoryNpm({ failHttpsWrite: true, failProxyDelete: true });
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandRunner: memory.runner,
            commandAvailable: () => true
        });

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(memory.values.proxy, OWNED);
        assert.deepStrictEqual(result.residualKeys, ['proxy']);
        assert.ok(!JSON.stringify(result).includes('s3cret-token'));
    });

    test('redacts credentials from the failed-write error path', async () => {
        const memory = createMemoryNpm({ failHttpsWrite: true });
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandRunner: memory.runner,
            commandAvailable: () => true
        });

        const result = await manager.setProxy(SECRET);

        assert.strictEqual(result.success, false);
        assert.ok(!JSON.stringify(result).includes('s3cret-token'));
    });

    test('isolated NPM_CONFIG_USERCONFIG: https-proxy write failure does not leave proxy', async function() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-npm-43-'));
        const userconfig = path.join(dir, 'npmrc');
        fs.writeFileSync(userconfig, '');
        const runner: NpmCommandRunner = async (command, args, options) => {
            if (args.includes('https-proxy') && (args.includes('set') || args.includes('config'))) {
                const setIndex = args.lastIndexOf('set');
                if (setIndex >= 0 && args[setIndex + 1] === 'https-proxy') {
                    throw execError(1, 'error: could not write https-proxy');
                }
            }
            return await execFileAsync(command, args, options);
        };
        const manager = new NpmConfigManager(userconfig, {
            isWindows: process.platform === 'win32',
            commandRunner: runner,
            env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig }
        });

        try {
            const result = await manager.setProxy(OWNED);
            if (result.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(result.success, false);
            const probe = new NpmConfigManager(userconfig, {
                isWindows: process.platform === 'win32',
                env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfig }
            });
            const inspection = await probe.inspectProxy();
            if (inspection.status !== 'available') {
                this.skip();
                return;
            }
            assert.strictEqual(inspection.values?.proxy ?? null, null, 'otak-proxy-written proxy must not remain');
            assert.strictEqual(inspection.values?.['https-proxy'] ?? null, null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
