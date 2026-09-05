import * as assert from 'assert';
import {
    ProxyCredentialStore,
    credentialsFromProcessEnv,
    getCredentialKeyForPublicUrl
} from '../../security/ProxyCredentialStore';
import { applyRemoteSyncState } from '../../sync/RemoteSyncStateApplier';
import {
    sanitizeProxyStateForPersistence,
    shouldSkipUnauthenticatedApply,
    UNRESOLVED_LOCAL_CREDENTIAL_ERROR
} from '../../utils/ProxyStateSanitizer';
import { ProxyMode, ProxyState } from '../../core/types';

interface SecretStorageLike {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    onDidChange(): { dispose(): void };
}

function createSecrets(map: Map<string, string>): SecretStorageLike {
    return {
        get: async (key: string) => map.get(key),
        store: async (key: string, value: string) => { map.set(key, value); },
        delete: async (key: string) => { map.delete(key); },
        onDidChange: () => ({ dispose: () => undefined })
    };
}

function createStore(secrets?: Map<string, string>): ProxyCredentialStore {
    if (!secrets) {
        return new ProxyCredentialStore(undefined);
    }
    return new ProxyCredentialStore(createSecrets(secrets) as never);
}

suite('Local credential resolution', () => {
    const publicUrl = 'http://proxy.example.com:8080/';
    const authenticatedUrl = 'http://user:s3cret@proxy.example.com:8080';

    test('reports notRequired when the endpoint has no credentials', async () => {
        const resolution = await createStore(new Map()).resolveLocalCredentials(publicUrl, false);
        assert.strictEqual(resolution.availability, 'notRequired');
        assert.strictEqual(resolution.resolvedUrl, undefined);
    });

    test('reconstructs credentials from SecretStorage on this machine', async () => {
        const secrets = new Map<string, string>();
        const store = createStore(secrets);
        await store.storeFromProxyUrl(authenticatedUrl);

        const resolution = await store.resolveLocalCredentials(publicUrl, true);
        assert.strictEqual(resolution.availability, 'availableOnThisMachine');
        assert.strictEqual(resolution.resolvedUrl, authenticatedUrl);
        assert.ok(!Array.from(secrets.values()).some(value => value.includes(authenticatedUrl)));
    });

    test('reports missingOnThisMachine when SecretStorage has no matching secret', async () => {
        const resolution = await createStore(new Map()).resolveLocalCredentials(publicUrl, true);
        assert.strictEqual(resolution.availability, 'missingOnThisMachine');
        assert.strictEqual(resolution.resolvedUrl, undefined);
    });

    test('reports secretStorageUnavailable when SecretStorage is missing', async () => {
        const resolution = await createStore().resolveLocalCredentials(publicUrl, true);
        assert.strictEqual(resolution.availability, 'secretStorageUnavailable');
        assert.strictEqual(resolution.resolvedUrl, undefined);
    });

    test('reports needsReEntry when the stored secret is empty', async () => {
        const secrets = new Map<string, string>([
            [getCredentialKeyForPublicUrl(publicUrl), JSON.stringify({ username: '', password: '' })]
        ]);
        const resolution = await createStore(secrets).resolveLocalCredentials(publicUrl, true);
        assert.strictEqual(resolution.availability, 'needsReEntry');
        assert.strictEqual(resolution.resolvedUrl, undefined);
    });

    test('resolves matching credentials from process env', async () => {
        const env = { HTTP_PROXY: authenticatedUrl };
        assert.deepStrictEqual(credentialsFromProcessEnv(publicUrl, env), {
            username: 'user',
            password: 's3cret'
        });

        const resolution = await createStore().resolveLocalCredentials(publicUrl, true, env);
        assert.strictEqual(resolution.availability, 'availableOnThisMachine');
        assert.strictEqual(resolution.resolvedUrl, authenticatedUrl);
    });

    test('authenticated Auto persist/sync payload has no password and the receiver applies reconstructed credentials', async () => {
        const secrets = new Map<string, string>();
        const store = createStore(secrets);
        await store.storeFromProxyUrl(authenticatedUrl);

        const syncPayload = sanitizeProxyStateForPersistence({
            mode: ProxyMode.Auto,
            autoProxyUrl: authenticatedUrl
        });
        assert.strictEqual(syncPayload.autoProxyUrl, publicUrl);
        assert.strictEqual(syncPayload.requiresAuth, true);
        assert.ok(!JSON.stringify(syncPayload).includes('s3cret'));

        const reconstructed = await store.reconstructProxyUrl(syncPayload.autoProxyUrl!);
        assert.strictEqual(reconstructed, authenticatedUrl);

        const calls: Array<{ url: string; enabled: boolean }> = [];
        const applied = await applyRemoteSyncState(syncPayload, {
            saveState: async () => undefined,
            getState: async () => ({
                mode: ProxyMode.Auto,
                autoProxyUrl: reconstructed,
                requiresAuth: true
            }),
            getActiveProxyUrl: (state: ProxyState) => state.autoProxyUrl || '',
            applyProxy: async (url, enabled) => {
                calls.push({ url, enabled });
                return true;
            },
            startMonitoring: async () => undefined,
            stopMonitoring: async () => undefined,
            updateStatus: () => undefined
        });

        assert.strictEqual(applied, true);
        assert.deepStrictEqual(calls, [{ url: authenticatedUrl, enabled: true }]);
    });

    test('skips silent unauthenticated apply when auth is required', () => {
        assert.strictEqual(
            shouldSkipUnauthenticatedApply({
                mode: ProxyMode.Auto,
                autoProxyUrl: publicUrl,
                requiresAuth: true
            }, publicUrl),
            true
        );
        assert.strictEqual(
            shouldSkipUnauthenticatedApply({
                mode: ProxyMode.Auto,
                autoProxyUrl: authenticatedUrl,
                requiresAuth: true
            }, authenticatedUrl),
            false
        );
        assert.ok(!UNRESOLVED_LOCAL_CREDENTIAL_ERROR.includes('s3cret'));
    });
});
