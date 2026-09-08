import * as assert from 'assert';
import {
    compensatePartialProxyWrite,
    summarizePartialWriteCompensation,
    UNREADABLE
} from '../config/PartialProxyWriteCompensation';

suite('PartialProxyWriteCompensation', () => {
    test('clears an introduced value and leaves an externally changed value', async () => {
        const current: Record<string, string | null> = {
            'http.proxy': 'http://owned.example:8080',
            'https.proxy': 'http://external.example:8080'
        };

        const result = await compensatePartialProxyWrite({
            written: [
                { key: 'http.proxy', value: 'http://owned.example:8080' },
                { key: 'https.proxy', value: 'http://owned.example:8080' }
            ],
            snapshot: { 'http.proxy': null, 'https.proxy': null },
            readCurrent: async key => current[key],
            restore: async () => {
                throw new Error('restore should not run for a missing snapshot');
            },
            clear: async key => {
                current[key] = null;
            }
        });

        assert.strictEqual(current['http.proxy'], null);
        assert.strictEqual(current['https.proxy'], 'http://external.example:8080');
        assert.deepStrictEqual(result.residualKeys, []);
        assert.deepStrictEqual(result.conflictedKeys, ['https.proxy']);
        assert.ok(!result.summary.includes('owned.example'));
    });

    test('records residual when clear cannot remove the written value', async () => {
        const result = await compensatePartialProxyWrite({
            written: [{ key: 'http.proxy', value: 'http://owned.example:8080' }],
            snapshot: { 'http.proxy': null },
            readCurrent: async () => 'http://owned.example:8080',
            restore: async () => undefined,
            clear: async () => {
                throw new Error('permission denied');
            }
        });

        assert.deepStrictEqual(result.residualKeys, ['http.proxy']);
        assert.ok(summarizePartialWriteCompensation('https.proxy', result).includes('https.proxy write failed'));
        assert.ok(!summarizePartialWriteCompensation('https.proxy', result).includes('owned.example'));
    });

    test('treats an unreadable current value as residual rather than inventing a restore', async () => {
        const result = await compensatePartialProxyWrite({
            written: [{ key: 'http.proxy', value: 'http://owned.example:8080' }],
            snapshot: { 'http.proxy': null },
            readCurrent: async () => UNREADABLE,
            restore: async () => undefined,
            clear: async () => undefined
        });

        assert.deepStrictEqual(result.residualKeys, ['http.proxy']);
        assert.strictEqual(result.keys[0].action, 'residual');
    });

    test('judges each key against the value written to that key (#73)', async () => {
        // A split apply: the two keys hold different values, both of them ours.
        const current: Record<string, string | null> = {
            proxy: 'http://http-side.example:8080',
            'https-proxy': 'http://https-side.example:8443'
        };

        const result = await compensatePartialProxyWrite({
            written: [
                { key: 'proxy', value: 'http://http-side.example:8080' },
                { key: 'https-proxy', value: 'http://https-side.example:8443' }
            ],
            snapshot: { proxy: null, 'https-proxy': null },
            readCurrent: async key => current[key],
            restore: async () => {
                throw new Error('restore should not run for a missing snapshot');
            },
            clear: async key => {
                current[key] = null;
            }
        });

        assert.deepStrictEqual(
            result.conflictedKeys,
            [],
            'our own value on the other key must not be mistaken for an external change'
        );
        assert.strictEqual(current.proxy, null);
        assert.strictEqual(current['https-proxy'], null);
    });
});
