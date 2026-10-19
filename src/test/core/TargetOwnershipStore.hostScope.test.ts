/**
 * @file TargetOwnershipStore.hostScope.test.ts
 * @description A remote window and a local window share one globalState (a
 * remote workspace extension's globalState is the local window's profile
 * storage), so ownership records are keyed by target id plus a host scope
 * (#108). Plain Node: the store only needs a Memento and a SecretStorage.
 */

import * as assert from 'assert';
import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { hostScope, HostIdentity, publicFingerprint, TargetOwnershipStore } from '../../core/TargetOwnershipStore';
import { ProxyCredentialStore } from '../../security/ProxyCredentialStore';

const OWNERSHIP_KEY = 'otakProxy.v3.localTargetOwnership';
const TARGET_ID = 'git.global.http.proxy';
const LOCAL_URL = 'http://local-proxy.example.com:8080/';
const REMOTE_URL = 'http://remote-proxy.example.com:3128/';

const IDENTITY: HostIdentity = {
    hostname: 'build-host-7',
    homedir: '/home/alice-secret',
    wslDistro: 'Ubuntu-22.04'
};

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

function createCredentials(): ProxyCredentialStore {
    const secrets = new Map<string, string>();
    return new ProxyCredentialStore({
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
        onDidChange: () => ({ dispose: () => {} })
    } as unknown as vscode.SecretStorage);
}

function storeFor(memory: Map<string, unknown>, scope?: string): TargetOwnershipStore {
    return scope === undefined
        ? new TargetOwnershipStore(createMemento(memory), createCredentials())
        : new TargetOwnershipStore(createMemento(memory), createCredentials(), scope);
}

async function record(store: TargetOwnershipStore, url: string): Promise<void> {
    await store.bootstrapFromSnapshot(url, [{ targetId: TARGET_ID, targetHost: 'workspaceHost', value: url }]);
}

suite('TargetOwnershipStore host scope (#108)', () => {
    test('a remote record and a local record for one target id coexist', async () => {
        const memory = new Map<string, unknown>();
        const local = storeFor(memory, '');
        const remote = storeFor(memory, 'ssh-remote:0123456789ab');

        await record(local, LOCAL_URL);
        await record(remote, REMOTE_URL);

        assert.strictEqual(await local.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'owned', 'local keeps its record');
        assert.strictEqual(await remote.inspectOwnership(TARGET_ID, REMOTE_URL, false), 'owned', 'remote keeps its record');
        assert.strictEqual(await local.inspectOwnership(TARGET_ID, REMOTE_URL, false), 'external');
        assert.strictEqual(await remote.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'external');
    });

    test('removing a record in one scope leaves the other scope\'s record', async () => {
        const memory = new Map<string, unknown>();
        const local = storeFor(memory, '');
        const remote = storeFor(memory, 'wsl:0123456789ab');
        await record(local, LOCAL_URL);
        await record(remote, REMOTE_URL);

        await remote.remove(TARGET_ID);

        assert.strictEqual(remote.get(TARGET_ID), undefined);
        assert.strictEqual(await local.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'owned');
    });

    test('two remote scopes that differ only in the WSL distribution coexist', async () => {
        const memory = new Map<string, unknown>();
        const ubuntu = storeFor(memory, hostScope('wsl', { ...IDENTITY, wslDistro: 'Ubuntu-22.04' }));
        const debian = storeFor(memory, hostScope('wsl', { ...IDENTITY, wslDistro: 'Debian' }));

        await record(ubuntu, LOCAL_URL);
        await record(debian, REMOTE_URL);

        assert.strictEqual(await ubuntu.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'owned');
        assert.strictEqual(await debian.inspectOwnership(TARGET_ID, REMOTE_URL, false), 'owned');
        assert.strictEqual(await ubuntu.inspectOwnership(TARGET_ID, REMOTE_URL, false), 'external');
    });

    test('two remote scopes that differ only in the home directory coexist', async () => {
        const memory = new Map<string, unknown>();
        const alice = storeFor(memory, hostScope('ssh-remote', { ...IDENTITY, homedir: '/home/alice' }));
        const bob = storeFor(memory, hostScope('ssh-remote', { ...IDENTITY, homedir: '/home/bob' }));

        await record(alice, LOCAL_URL);
        await record(bob, REMOTE_URL);

        assert.strictEqual(await alice.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'owned');
        assert.strictEqual(await bob.inspectOwnership(TARGET_ID, REMOTE_URL, false), 'owned');
        assert.strictEqual(await bob.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'external');
    });

    test('a record stored under today\'s key is read by the local scope', async () => {
        const memory = new Map<string, unknown>();
        memory.set(OWNERSHIP_KEY, {
            [TARGET_ID]: {
                targetId: TARGET_ID,
                targetHost: 'workspaceHost',
                owner: 'otakProxy',
                publicFingerprint: publicFingerprint(LOCAL_URL)
            }
        });

        assert.strictEqual(await storeFor(memory, '').inspectOwnership(TARGET_ID, LOCAL_URL, false), 'owned');
        assert.strictEqual(
            await storeFor(memory).inspectOwnership(TARGET_ID, LOCAL_URL, false),
            'owned',
            'the default scope of a local window (no remoteName) is the local scope'
        );
    });

    test('a remote scope does not read a record stored under today\'s key', async () => {
        const memory = new Map<string, unknown>();
        await record(storeFor(memory, ''), LOCAL_URL);

        const remote = storeFor(memory, 'ssh-remote:0123456789ab');

        assert.strictEqual(remote.get(TARGET_ID), undefined);
        assert.strictEqual(await remote.inspectOwnership(TARGET_ID, LOCAL_URL, false), 'external');
    });

    test('the stored map holds none of the host identity in plain text', async () => {
        const memory = new Map<string, unknown>();
        await record(storeFor(memory, hostScope('ssh-remote', IDENTITY)), REMOTE_URL);

        const stored = JSON.stringify(memory.get(OWNERSHIP_KEY));

        assert.ok(stored.includes(TARGET_ID), 'sanity: the record is in the map');
        for (const secret of [IDENTITY.hostname, IDENTITY.homedir, IDENTITY.wslDistro!]) {
            assert.ok(!stored.includes(secret), `${secret} must not be stored in plain text: ${stored}`);
        }
    });
});

suite('hostScope (#108)', () => {
    const expectedDigest = (identity: HostIdentity): string =>
        crypto.createHash('sha256')
            .update([identity.hostname, identity.homedir, identity.wslDistro ?? ''].join('\0'))
            .digest('hex')
            .slice(0, 12);

    test('a local window has the empty scope', () => {
        assert.strictEqual(hostScope(undefined, IDENTITY), '');
        assert.strictEqual(hostScope('', IDENTITY), '');
    });

    test('a remote scope is the remote name plus 12 hex characters of the identity digest', () => {
        const scope = hostScope('ssh-remote', IDENTITY);

        assert.strictEqual(scope, `ssh-remote:${expectedDigest(IDENTITY)}`);
        assert.ok(/^ssh-remote:[0-9a-f]{12}$/.test(scope), scope);
    });

    test('an unset WSL distribution digests as the empty string', () => {
        const withoutDistro: HostIdentity = { hostname: IDENTITY.hostname, homedir: IDENTITY.homedir };

        assert.strictEqual(hostScope('ssh-remote', withoutDistro), `ssh-remote:${expectedDigest(withoutDistro)}`);
        assert.strictEqual(
            hostScope('ssh-remote', withoutDistro),
            hostScope('ssh-remote', { ...withoutDistro, wslDistro: '' })
        );
    });

    test('every part of the identity changes the scope', () => {
        const base = hostScope('wsl', IDENTITY);
        const variants = [
            hostScope('ssh-remote', IDENTITY),
            hostScope('wsl', { ...IDENTITY, hostname: 'other-host' }),
            hostScope('wsl', { ...IDENTITY, homedir: '/home/other' }),
            hostScope('wsl', { ...IDENTITY, wslDistro: 'Debian' })
        ];
        for (const variant of variants) {
            assert.notStrictEqual(variant, base);
        }
        assert.strictEqual(new Set([base, ...variants]).size, variants.length + 1);
    });

    test('the parts are separated, so moving a character between them changes the scope', () => {
        assert.notStrictEqual(
            hostScope('wsl', { hostname: 'ab', homedir: 'c', wslDistro: '' }),
            hostScope('wsl', { hostname: 'a', homedir: 'bc', wslDistro: '' })
        );
    });
});
