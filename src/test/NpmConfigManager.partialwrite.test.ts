import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { NpmCommandRunner, NpmConfigManager, NpmProxyKey } from '../config/NpmConfigManager';
import { createFakeNpmConfig, FakeNpmConfig, npmIniSafe } from './fakeConfigStores';

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

const MEMORY_USERCONFIG = '/memory-npm/.npmrc';

function createMemoryNpm(options: {
    failHttpsWrite?: boolean;
    externalizeProxyAfterWrite?: boolean;
    failProxyDelete?: boolean;
}): {
    values: Record<NpmProxyKey, string | null>;
    runner: NpmCommandRunner;
    readUserConfigFile(path: string): Promise<string>;
} {
    const values: Record<NpmProxyKey, string | null> = {
        proxy: null,
        'https-proxy': null
    };

    const runner: NpmCommandRunner = async (_command, args) => {
        if (args.includes('get') && args.includes('userconfig')) {
            return { stdout: `${MEMORY_USERCONFIG}\n`, stderr: '' };
        }
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

    // `values` is the user layer: the file npm would report through
    // `config get userconfig` reflects exactly these keys (#138).
    const readUserConfigFile = async (path: string): Promise<string> => {
        if (path !== MEMORY_USERCONFIG) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
        }
        return (Object.entries(values) as Array<[NpmProxyKey, string | null]>)
            .filter(([, value]) => value !== null)
            .map(([key, value]) => `${key}=${npmIniSafe(value as string)}\n`)
            .join('');
    };

    return { values, runner, readUserConfigFile };
}

suite('NpmConfigManager partial multi-key write (#43)', () => {
    test('first write succeeds, second write fails, first value is compensated away', async () => {
        const memory = createMemoryNpm({ failHttpsWrite: true });
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandRunner: memory.runner,
            readUserConfigFile: memory.readUserConfigFile,
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
            readUserConfigFile: memory.readUserConfigFile,
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
            readUserConfigFile: memory.readUserConfigFile,
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
            readUserConfigFile: memory.readUserConfigFile,
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

suite('npm compensation writes only the user layer (#138)', () => {
    const GLOBAL_ONLY = 'http://global-proxy.example:3128';

    function layeredNpmBacked(npm: FakeNpmConfig, failKey: NpmProxyKey): {
        manager: NpmConfigManager;
        calls: string[][];
    } {
        const calls: string[][] = [];
        const manager = new NpmConfigManager(undefined, {
            isWindows: false,
            commandAvailable: () => true,
            commandRunner: async (command, args, options) => {
                calls.push(args);
                if (args.includes('set') && args.includes(failKey)) {
                    throw execError(1, `error: could not write ${failKey}`);
                }
                return npm.runner(command, args, options);
            },
            readUserConfigFile: npm.readUserConfigFile
        });
        return { manager, calls };
    }

    test('a global-layer value is not copied into the user .npmrc', async () => {
        // `config get` merges layers, so the snapshot must come from the user
        // layer alone: a key the user file does not hold is restored by
        // `config delete`, never by writing the merged value into the file.
        const npm = createFakeNpmConfig({}, { global: { proxy: GLOBAL_ONLY } });
        const { manager, calls } = layeredNpmBacked(npm, 'https-proxy');

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(npm.get('proxy'), null, 'the user config must not gain the global value');
        assert.strictEqual(npm.getGlobal('proxy'), GLOBAL_ONLY, 'the global layer is untouched');
        assert.ok(
            !calls.some(args => args.includes('set') && args.includes('proxy') && args.includes(GLOBAL_ONLY)),
            'compensation must delete the written key, not restore the merged value'
        );
    });

    test('a pre-existing user-layer value is still restored by compensation', async () => {
        const npm = createFakeNpmConfig({ proxy: EXTERNAL });
        const { manager } = layeredNpmBacked(npm, 'https-proxy');

        const result = await manager.setProxy(OWNED);

        assert.strictEqual(result.success, false);
        assert.strictEqual(npm.get('proxy'), EXTERNAL, 'the user value predating the write comes back');
    });
});
