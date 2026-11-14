/**
 * Split-proxy partial-write compensation tests for npm (#73).
 *
 * On a split apply, `ProxyApplier.splitAwareTarget()` calls
 * `setProxyKeys({ proxy: httpUrl, 'https-proxy': httpsUrl })` with two
 * *different* values. The compensation path was written for the single-value
 * case: it compensates every key against one `writtenValue`, then re-runs the
 * keys whose value differs and *replaces* the whole result object. Whatever
 * the first pass established about the other key is discarded - including a
 * residual that ownership tracking needs in order to clean up later, and a
 * conflict the user needs in order to know their own setting was kept.
 */

import * as assert from 'assert';
import { npmIniSafe } from './fakeConfigStores';
import { NpmCommandRunner, NpmConfigManager, NpmProxyKey } from '../config/NpmConfigManager';

const HTTP_URL = 'http://http-side.example:8080';
const HTTPS_URL = 'http://https-side.example:8443';
const EXTERNAL = 'http://external.example:3128';
const USERCONFIG = '/fake-npm-userconfig/.npmrc';

function execError(code: number, stderr: string): Error & { code: number; stderr: string } {
    return Object.assign(new Error('Command failed: npm config'), { code, stderr });
}

interface FakeNpm {
    runner: NpmCommandRunner;
    values: Record<NpmProxyKey, string | null>;
    commands: string[][];
    readUserConfigFile(path: string): Promise<string>;
}

/**
 * In-memory npm config. `values` is the user layer: `config get` merges (and
 * `readAs` can shadow it), while `config set`/`delete` and the user config
 * file `readUserConfigFile` serves all act on `values` alone — the contract
 * the real npm gives (#138).
 *
 * - `externalizeAfterWrite`: another writer replaces the value right after we
 *   set it, so our write is real but no longer ours.
 * - `readAs`: a key always reports a value other than what is stored, so our
 *   write never became visible at all.
 * - `failDelete`: compensation cannot remove the key.
 */
function createFakeNpm(options: {
    externalizeAfterWrite?: NpmProxyKey;
    readAs?: Partial<Record<NpmProxyKey, string | null>>;
    failDelete?: NpmProxyKey;
} = {}): FakeNpm {
    const values: Record<NpmProxyKey, string | null> = { proxy: null, 'https-proxy': null };
    const commands: string[][] = [];

    const runner: NpmCommandRunner = async (_command, args) => {
        commands.push([...args]);

        if (args.includes('get') && args.includes('userconfig')) {
            return { stdout: `${USERCONFIG}\n`, stderr: '' };
        }

        const key: NpmProxyKey = args.includes('https-proxy') ? 'https-proxy' : 'proxy';

        if (args.includes('get')) {
            const override = options.readAs?.[key];
            const value = override !== undefined ? override : values[key];
            return { stdout: `${value ?? 'null'}\n`, stderr: '' };
        }

        if (args.includes('delete')) {
            if (options.failDelete === key) {
                throw execError(1, 'npm ERR! code EACCES');
            }
            values[key] = null;
            return { stdout: '', stderr: '' };
        }

        values[key] = options.externalizeAfterWrite === key ? EXTERNAL : args[args.length - 1];
        return { stdout: '', stderr: '' };
    };

    return {
        runner,
        values,
        commands,
        readUserConfigFile: async path => {
            if (path !== USERCONFIG) {
                throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
            }
            return (Object.entries(values) as Array<[NpmProxyKey, string | null]>)
                .filter(([, value]) => value !== null)
                .map(([key, value]) => `${key}=${npmIniSafe(value as string)}\n`)
                .join('');
        }
    };
}

function managerFor(npm: FakeNpm): NpmConfigManager {
    return new NpmConfigManager(undefined, {
        commandRunner: npm.runner,
        isWindows: false,
        env: {},
        commandAvailable: () => true,
        readUserConfigFile: npm.readUserConfigFile
    });
}

suite('NpmConfigManager split-proxy compensation (#73)', () => {
    test('reports the externally changed key after compensating the other one', async () => {
        // An external writer replaces https-proxy immediately after our write,
        // so verification fails and that key must be left alone - and said so.
        const npm = createFakeNpm({ externalizeAfterWrite: 'https-proxy' });

        const result = await managerFor(npm).setProxyKeys({
            proxy: HTTP_URL,
            'https-proxy': HTTPS_URL
        });

        assert.strictEqual(result.success, false, 'the failed verification must surface');
        assert.deepStrictEqual(
            npm.values.proxy,
            null,
            'our own http value must be compensated away'
        );
        assert.ok(
            /left unchanged after external change:[^;]*https-proxy/.test(result.error ?? ''),
            `the externally changed key must survive into the reported summary: ${result.error}`
        );
    });

    test('keeps the https residual when the http key is compensated afterwards', async () => {
        // Verification fails on `proxy` (it never became visible), while
        // `https-proxy` still holds our value but cannot be deleted.
        const npm = createFakeNpm({
            readAs: { proxy: EXTERNAL },
            failDelete: 'https-proxy'
        });

        const result = await managerFor(npm).setProxyKeys({
            proxy: HTTP_URL,
            'https-proxy': HTTPS_URL
        });

        assert.strictEqual(result.success, false, 'the failed verification must surface');
        assert.deepStrictEqual(
            result.residualKeys,
            ['https-proxy'],
            'a value we could not remove must stay reported so ownership tracking can clean it up'
        );
        assert.ok(
            /residual remains:[^;]*https-proxy/.test(result.error ?? ''),
            `the residual must survive into the reported summary: ${result.error}`
        );
    });

    test('every written key is compensated exactly once', async () => {
        const npm = createFakeNpm({ externalizeAfterWrite: 'https-proxy' });

        await managerFor(npm).setProxyKeys({ proxy: HTTP_URL, 'https-proxy': HTTPS_URL });

        const deletes = npm.commands.filter(args => args.includes('delete'));
        const proxyDeletes = deletes.filter(args => !args.includes('https-proxy'));
        assert.strictEqual(
            proxyDeletes.length,
            1,
            `proxy must be compensated once, not re-compensated: ${JSON.stringify(deletes)}`
        );
    });

    test('non-split writes keep their existing compensation behaviour', async () => {
        // Both keys carry the same value: the pre-existing single-value path.
        const npm = createFakeNpm({ externalizeAfterWrite: 'https-proxy' });

        const result = await managerFor(npm).setProxyKeys({
            proxy: HTTP_URL,
            'https-proxy': HTTP_URL
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(npm.values.proxy, null, 'the http value must still be compensated away');
        assert.ok(
            /left unchanged after external change:[^;]*https-proxy/.test(result.error ?? ''),
            `the externally changed key must still be reported: ${result.error}`
        );
    });
});
