/**
 * Off-path terminal masking must not empty unowned NO_PROXY / no_proxy (#57).
 */
import * as assert from 'assert';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';

type CollectionOp =
    | { op: 'replace'; name: string; value: string }
    | { op: 'delete'; name: string };

function createCollectionDouble(initial: Record<string, string> = {}) {
    const values = new Map<string, string>(Object.entries(initial));
    const ops: CollectionOp[] = [];
    const collection = {
        replace(name: string, value: string): void {
            ops.push({ op: 'replace', name, value });
            values.set(name, value);
        },
        delete(name: string): void {
            ops.push({ op: 'delete', name });
            values.delete(name);
        },
        get(name: string): { type: number; value: string } | undefined {
            if (!values.has(name)) {
                return undefined;
            }
            return { type: 1, value: values.get(name)! };
        },
        *[Symbol.iterator](): IterableIterator<[string, { type: number; value: string }]> {
            for (const [name, value] of values) {
                yield [name, { type: 1, value }];
            }
        }
    };
    return { collection, values, ops };
}

function touchedNames(ops: CollectionOp[], names: string[]): string[] {
    return ops.filter(op => names.includes(op.name)).map(op => `${op.op}:${op.name}`);
}

const BYPASS_VARS = ['NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'];

suite('TerminalEnv Off mask ownership (#57)', () => {
    test('set then unset with default mask does not touch unowned NO_PROXY or ALL_PROXY', async () => {
        const inheritedEnv = {
            NO_PROXY: 'localhost,*.corp',
            no_proxy: 'localhost,*.corp'
        };
        const double = createCollectionDouble();
        const manager = new TerminalEnvConfigManager(double.collection, {
            includeLowercase: true,
            maskOnUnset: true
        });

        await manager.setProxy('http://proxy.example.com:8080');
        const afterSet = [...double.ops];
        await manager.unsetProxy();

        assert.deepStrictEqual(
            touchedNames(afterSet, BYPASS_VARS),
            [],
            'setProxy without noProxy must not write bypass variables'
        );
        assert.deepStrictEqual(
            touchedNames(double.ops, BYPASS_VARS),
            [],
            'Off mask must not replace or delete unowned NO_PROXY / ALL_PROXY'
        );
        assert.strictEqual(inheritedEnv.NO_PROXY, 'localhost,*.corp');
        assert.strictEqual(inheritedEnv.no_proxy, 'localhost,*.corp');
        assert.strictEqual(double.values.get('HTTP_PROXY'), '');
        assert.strictEqual(double.values.get('HTTPS_PROXY'), '');
        assert.strictEqual(double.values.get('http_proxy'), '');
        assert.strictEqual(double.values.get('https_proxy'), '');
        assert.ok(!double.values.has('NO_PROXY'));
        assert.ok(!double.values.has('no_proxy'));
    });

    test('pre-existing inherited NO_PROXY fixture is not emptied on Off mask', async () => {
        const inheritedEnv = { NO_PROXY: '127.0.0.1,::1' };
        const double = createCollectionDouble();
        const manager = new TerminalEnvConfigManager(double.collection, {
            includeLowercase: false,
            maskOnUnset: true
        });

        await manager.unsetProxy();

        assert.strictEqual(inheritedEnv.NO_PROXY, '127.0.0.1,::1');
        assert.ok(!double.ops.some(op => op.name === 'NO_PROXY'));
        assert.ok(!double.values.has('NO_PROXY'));
        assert.strictEqual(double.values.get('HTTP_PROXY'), '');
        assert.strictEqual(double.values.get('HTTPS_PROXY'), '');
    });

    test('maskOnUnset=false deletes only otak-applied proxy vars and leaves NO_PROXY', async () => {
        const inheritedEnv = { NO_PROXY: 'localhost' };
        const double = createCollectionDouble();
        const manager = new TerminalEnvConfigManager(double.collection, {
            includeLowercase: false,
            maskOnUnset: false
        });

        await manager.setProxy('http://proxy.example.com:8080');
        await manager.unsetProxy();

        assert.deepStrictEqual(
            double.ops.filter(op => op.op === 'replace' && op.value === ''),
            [],
            'maskOnUnset=false must delete, not empty-replace'
        );
        assert.ok(double.ops.some(op => op.op === 'delete' && op.name === 'HTTP_PROXY'));
        assert.ok(double.ops.some(op => op.op === 'delete' && op.name === 'HTTPS_PROXY'));
        assert.ok(!double.ops.some(op => op.name === 'NO_PROXY'));
        assert.strictEqual(inheritedEnv.NO_PROXY, 'localhost');
        assert.ok(!double.values.has('HTTP_PROXY'));
        assert.ok(!double.values.has('NO_PROXY'));
    });

    test('owned NO_PROXY written via options.noProxy is cleared on Off, ALL_PROXY is not invented', async () => {
        const double = createCollectionDouble();
        const manager = new TerminalEnvConfigManager(double.collection, {
            includeLowercase: false,
            noProxy: 'localhost,127.0.0.1',
            maskOnUnset: true
        });

        await manager.setProxy('http://proxy.example.com:8080');
        assert.strictEqual(double.values.get('NO_PROXY'), 'localhost,127.0.0.1');

        await manager.unsetProxy();
        assert.strictEqual(double.values.get('NO_PROXY'), '');
        assert.strictEqual(double.values.has('ALL_PROXY'), false);
        assert.ok(!double.ops.some(op => op.name === 'ALL_PROXY'));
    });

    test('leftover empty NO_PROXY mutator from an older Off mask is deleted, not remasked', async () => {
        const double = createCollectionDouble({
            NO_PROXY: '',
            ALL_PROXY: ''
        });
        const manager = new TerminalEnvConfigManager(double.collection, {
            includeLowercase: false,
            maskOnUnset: true
        });

        await manager.unsetProxy();

        assert.ok(!double.values.has('NO_PROXY'));
        assert.ok(!double.values.has('ALL_PROXY'));
        assert.ok(double.ops.some(op => op.op === 'delete' && op.name === 'NO_PROXY'));
        assert.ok(double.ops.some(op => op.op === 'delete' && op.name === 'ALL_PROXY'));
        assert.ok(!double.ops.some(op => op.op === 'replace' && op.name === 'NO_PROXY'));
        assert.ok(!double.ops.some(op => op.op === 'replace' && op.name === 'ALL_PROXY'));
        assert.strictEqual(double.values.get('HTTP_PROXY'), '');
        assert.strictEqual(double.values.get('HTTPS_PROXY'), '');
    });
});
