import * as assert from 'assert';
import { compareThenDelete, UNSET_UNREADABLE } from '../config/ValueAwareUnset';

suite('compareThenDelete', () => {
    test('skips delete when the current value is no longer the owned value', async () => {
        let deleted = false;
        const result = await compareThenDelete({
            expected: 'http://owned.example:8080',
            read: async () => 'http://external.example:8080',
            deleteKey: async () => {
                deleted = true;
            }
        });
        assert.deepStrictEqual(result, { ok: true, skipped: true, preserved: true });
        assert.strictEqual(deleted, false);
    });

    test('deletes the owned value and post-reads emptiness', async () => {
        let current: string | null = 'http://owned.example:8080';
        const result = await compareThenDelete({
            expected: 'http://owned.example:8080',
            read: async () => current,
            deleteKey: async () => {
                current = null;
            }
        });
        assert.deepStrictEqual(result, { ok: true, skipped: false, preserved: false });
    });

    test('fails closed when the confirming read cannot be performed', async () => {
        const result = await compareThenDelete({
            expected: 'http://owned.example:8080',
            read: async () => UNSET_UNREADABLE,
            deleteKey: async () => {
                throw new Error('delete must not run');
            }
        });
        assert.deepStrictEqual(result, { ok: false, reason: 'unreadable' });
    });
});
