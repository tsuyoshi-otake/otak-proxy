/**
 * @file TargetOwnershipStore.inspectOwnership.test.ts
 * @description The three ownership verdicts Off acts on (#108): owned, external, unverifiable.
 * Plain Node: the store only needs a Memento and a SecretStorage, both Map-backed here.
 */

import * as assert from 'assert';
import type * as vscode from 'vscode';
import { publicFingerprint, TargetOwnershipStore } from '../../core/TargetOwnershipStore';
import { ProxyCredentialStore } from '../../security/ProxyCredentialStore';

const URL = 'http://alice:s3cret@proxy.example.com:8080/';
const PUBLIC_URL = 'http://proxy.example.com:8080/';
const SNAPSHOT = { targetId: 'git.global.http.proxy', targetHost: 'workspaceHost' as const };

function createMemento(store: Map<string, unknown>): vscode.Memento {
    return {
        get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
        update: async (key: string, value: unknown) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        keys: () => [...store.keys()]
    } as unknown as vscode.Memento;
}

function createSecrets(secrets: Map<string, string>): vscode.SecretStorage {
    return {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
        onDidChange: () => ({ dispose: () => {} })
    } as unknown as vscode.SecretStorage;
}

function emptyStore(): { ownership: TargetOwnershipStore; secrets: Map<string, string> } {
    const secrets = new Map<string, string>();
    const ownership = new TargetOwnershipStore(
        createMemento(new Map()),
        new ProxyCredentialStore(createSecrets(secrets))
    );
    return { ownership, secrets };
}

/** A store in which otak-proxy recorded `URL` for the Git target, as an apply does. */
async function ownedStore(): Promise<{ ownership: TargetOwnershipStore; secrets: Map<string, string> }> {
    const result = emptyStore();
    await result.ownership.bootstrapFromSnapshot(PUBLIC_URL, [{ ...SNAPSHOT, value: PUBLIC_URL }], URL);
    return result;
}

suite('TargetOwnershipStore.inspectOwnership verdicts (#108)', () => {
    test('a record that matches the observed value is owned', async () => {
        const { ownership } = await ownedStore();
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, URL, true), 'owned');
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, PUBLIC_URL, false), 'owned');
    });

    test('a target with no record is external', async () => {
        const { ownership } = await ownedStore();
        assert.strictEqual(await ownership.inspectOwnership('git.global.https.proxy', URL, true), 'external');
        assert.strictEqual(await ownership.inspectOwnership('git.global.https.proxy', PUBLIC_URL, false), 'external');
    });

    test('a record owned by someone else is external even when its fingerprint matches', async () => {
        const { ownership } = emptyStore();
        await ownership.update({
            ...SNAPSHOT,
            owner: 'external',
            publicFingerprint: publicFingerprint(PUBLIC_URL)
        });
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, PUBLIC_URL, false), 'external');
        assert.strictEqual(
            await ownership.inspectOwnership(SNAPSHOT.targetId, URL, true),
            'external',
            'a value the user owns is never "unverifiable", even without a secret-aware fingerprint'
        );
    });

    test('a value whose fingerprint differs from the record is external', async () => {
        const { ownership } = await ownedStore();
        assert.strictEqual(
            await ownership.inspectOwnership(SNAPSHOT.targetId, 'http://alice:other@proxy.example.com:8080/', true),
            'external'
        );
        assert.strictEqual(
            await ownership.inspectOwnership(SNAPSHOT.targetId, 'http://other.example.com:8080/', false),
            'external'
        );
    });

    test('a secret-bearing value is unverifiable when the HMAC key is gone', async () => {
        const { ownership, secrets } = await ownedStore();
        secrets.clear();
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, URL, true), 'unverifiable');
    });

    test('a secret-bearing value is unverifiable when the record has no secret-aware fingerprint', async () => {
        const { ownership } = emptyStore();
        await ownership.update({
            ...SNAPSHOT,
            owner: 'otakProxy',
            publicFingerprint: publicFingerprint(PUBLIC_URL)
        });
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, URL, true), 'unverifiable');
    });

    test('a credential-free value is judged by its public fingerprint when the HMAC key is gone', async () => {
        const { ownership, secrets } = await ownedStore();
        secrets.clear();
        assert.strictEqual(await ownership.inspectOwnership(SNAPSHOT.targetId, PUBLIC_URL, false), 'owned');
        assert.strictEqual(
            await ownership.inspectOwnership(SNAPSHOT.targetId, 'http://other.example.com:8080/', false),
            'external'
        );
    });
});
