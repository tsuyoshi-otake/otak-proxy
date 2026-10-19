/**
 * Runtime hydration of a stored state (#108): which SecretStorage keys one
 * getState() reads, and the hydrated state it returns.
 *
 * The result table pins what hydration returned before the reads were cut
 * (every row passed on the unchanged code first); the key-list rows pin the
 * cut itself. SecretStorage is faked with a recording `get`, and a first
 * getState() completes the v3 migration journal before any row seeds its
 * state, so a leftover legacy key is still there when the row runs.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { LEGACY_MANUAL_PROXY_SECRET_KEY, V3_MIGRATION_JOURNAL_KEY } from '../core/V3MigrationService';
import { getCredentialKeyForPublicUrl } from '../security/ProxyCredentialStore';
import { getProxyPublicUrl } from '../utils/ProxyStateSanitizer';
import { createRealStateManager, RealStateManagerHarness } from './realProxyStateManager';

const PROXY_ENV_NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

const P = 'http://proxy.example.com:8080';
const Q = 'http://other.example.com:8081';
const M = 'http://manual.example.com:3128';
const P_ALICE = 'http://alice:s3cret@proxy.example.com:8080';
const M_LEGACY = 'http://legacyuser:legacypass@manual.example.com:3128';
const M_BOB = 'http://bob:bobpass@manual.example.com:3128';

// SecretStorage is keyed by the public URL in `getProxyPublicUrl` form (trailing slash).
const PUB_P = getProxyPublicUrl(P)!;
const PUB_Q = getProxyPublicUrl(Q)!;
const PUB_M = getProxyPublicUrl(M)!;

const KEY_LABELS = new Map<string, string>([
    [getCredentialKeyForPublicUrl(PUB_P), 'K(P)'],
    [getCredentialKeyForPublicUrl(PUB_Q), 'K(Q)'],
    [getCredentialKeyForPublicUrl(PUB_M), 'K(M)'],
    [LEGACY_MANUAL_PROXY_SECRET_KEY, 'L']
]);

interface Row {
    name: string;
    state: Partial<ProxyState>;
    /** Credentials stored in SecretStorage, by public URL. */
    credentials?: Record<string, { username: string; password: string }>;
    /** Value of the leftover legacy key `otakProxy.manualProxyUrl`. */
    legacy?: string;
    /** `otakProxy.proxyUrl` as the user wrote it. */
    setting?: string;
    /** `HTTP_PROXY` of the extension host process. */
    processEnv?: string;
    expected: Partial<ProxyState>;
    /** The SecretStorage keys one getState() reads, in order. */
    reads?: string[];
}

const ALICE = { username: 'alice', password: 's3cret' };

const ROWS: Row[] = [
    {
        name: 'auto, lastSystem and both splits name the same proxy: one read, all four hydrated',
        state: { autoProxyUrl: P, autoHttpProxyUrl: P, autoHttpsProxyUrl: P, lastSystemProxyUrl: P },
        credentials: { [PUB_P]: ALICE },
        expected: {
            autoProxyUrl: P_ALICE, autoHttpProxyUrl: P_ALICE, autoHttpsProxyUrl: P_ALICE, lastSystemProxyUrl: P_ALICE,
            requiresAuth: true, authRequiredProxyUrls: [PUB_P]
        },
        // Before the reads were cut: ['L', 'K(P)', 'K(P)', 'K(P)', 'K(P)'].
        reads: ['K(P)']
    },
    {
        name: 'a configured credential-free manual URL that equals the fallback, plus the same auto fields',
        state: { autoProxyUrl: P, autoHttpProxyUrl: P, autoHttpsProxyUrl: P, fallbackProxyUrl: M, lastSystemProxyUrl: P },
        credentials: { [PUB_P]: ALICE },
        setting: M,
        expected: {
            manualProxyUrl: M,
            autoProxyUrl: P_ALICE, autoHttpProxyUrl: P_ALICE, autoHttpsProxyUrl: P_ALICE, fallbackProxyUrl: M,
            lastSystemProxyUrl: P_ALICE,
            requiresAuth: true, authRequiredProxyUrls: [PUB_P]
        },
        // Before the reads were cut: ['K(M)', 'L', 'K(P)', 'K(P)', 'K(P)', 'K(M)', 'K(P)'].
        reads: ['K(M)', 'L', 'K(P)']
    },
    {
        name: 'a split where only one of two addresses has its secret',
        state: { autoProxyUrl: P, autoHttpProxyUrl: P, autoHttpsProxyUrl: Q },
        credentials: { [PUB_P]: ALICE },
        expected: {
            autoProxyUrl: P_ALICE, autoHttpProxyUrl: P_ALICE, autoHttpsProxyUrl: Q,
            requiresAuth: true, authRequiredProxyUrls: [PUB_P]
        },
        reads: ['K(P)', 'K(Q)']
    },
    {
        name: 'credentials already in the URL are kept; a public lastSystem for the same address is hydrated',
        state: { autoProxyUrl: 'http://carol:other@proxy.example.com:8080', lastSystemProxyUrl: P },
        credentials: { [PUB_P]: ALICE },
        expected: {
            autoProxyUrl: 'http://carol:other@proxy.example.com:8080', lastSystemProxyUrl: P_ALICE,
            requiresAuth: true, authRequiredProxyUrls: [PUB_P]
        },
        reads: ['K(P)']
    },
    {
        name: 'process-environment credentials fill an address with no stored secret',
        state: { autoProxyUrl: P, lastSystemProxyUrl: P },
        processEnv: 'http://envuser:envpass@proxy.example.com:8080',
        expected: {
            autoProxyUrl: 'http://envuser:envpass@proxy.example.com:8080',
            lastSystemProxyUrl: 'http://envuser:envpass@proxy.example.com:8080',
            requiresAuth: true, authRequiredProxyUrls: [PUB_P]
        },
        reads: ['K(P)']
    },
    {
        name: 'a stored secret wins over the process environment',
        state: { autoProxyUrl: P },
        credentials: { [PUB_P]: ALICE },
        processEnv: 'http://envuser:envpass@proxy.example.com:8080',
        expected: { autoProxyUrl: P_ALICE, requiresAuth: true, authRequiredProxyUrls: [PUB_P] },
        reads: ['K(P)']
    },
    {
        name: 'manual URL and fallback name the same address: both hydrated from its secret',
        state: { manualProxyUrl: M, fallbackProxyUrl: M },
        credentials: { [PUB_M]: { username: 'bob', password: 'bobpass' } },
        expected: {
            manualProxyUrl: M_BOB, fallbackProxyUrl: M_BOB,
            requiresAuth: true, authRequiredProxyUrls: [PUB_M]
        },
        reads: ['K(M)']
    },
    {
        name: 'a leftover legacy key with no manual URL and no setting: state unchanged, legacy key not read',
        state: { autoProxyUrl: Q },
        legacy: M_LEGACY,
        expected: { autoProxyUrl: Q },
        // Before the reads were cut: ['L', 'K(Q)'].
        reads: ['K(Q)']
    },
    {
        name: 'a configured manual URL whose keyed secret is missing still takes the legacy value',
        state: { autoProxyUrl: Q },
        legacy: M_LEGACY,
        setting: M,
        expected: { manualProxyUrl: M_LEGACY, autoProxyUrl: Q, requiresAuth: true, authRequiredProxyUrls: [PUB_M] },
        reads: ['K(M)', 'L', 'K(Q)']
    },
    {
        name: 'a stored manual URL whose keyed secret is missing still takes the legacy value for the same address',
        state: { manualProxyUrl: M },
        legacy: M_LEGACY,
        expected: { manualProxyUrl: M_LEGACY, requiresAuth: true, authRequiredProxyUrls: [PUB_M] },
        reads: ['K(M)', 'L']
    },
    {
        name: 'a legacy value for another address does not replace the stored manual URL',
        state: { manualProxyUrl: M },
        legacy: 'http://legacyuser:legacypass@proxy.example.com:8080',
        expected: { manualProxyUrl: M },
        reads: ['K(M)', 'L']
    },
    {
        name: 'a configured manual URL with credentials in the setting seeds the manual URL',
        state: { autoProxyUrl: Q },
        setting: M_BOB,
        expected: { manualProxyUrl: M_BOB, autoProxyUrl: Q, requiresAuth: true, authRequiredProxyUrls: [PUB_M] }
    }
];

suite('ProxyStateManager runtime hydration (#108)', () => {
    let originalGetConfiguration: typeof vscode.workspace.getConfiguration;
    let savedEnv: Record<string, string | undefined>;
    let harness: RealStateManagerHarness;
    let reads: string[];

    setup(async () => {
        originalGetConfiguration = vscode.workspace.getConfiguration;
        savedEnv = {};
        for (const name of PROXY_ENV_NAMES) {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        }
        harness = createRealStateManager(config => {
            (vscode.workspace as unknown as { getConfiguration: () => unknown }).getConfiguration = () => config;
        });
        reads = [];
        const secrets = harness.extensionContext.secrets as unknown as { get: (key: string) => Promise<string | undefined> };
        const get = secrets.get;
        secrets.get = async key => {
            reads.push(KEY_LABELS.get(key) ?? key);
            return get(key);
        };
        // Complete the v3 migration journal on an empty store.
        await harness.reload();
        const journal = harness.extensionContext.globalState.get<{ phase?: string }>(V3_MIGRATION_JOURNAL_KEY);
        assert.strictEqual(journal?.phase, 'completed', 'the first getState() must complete the migration journal');
    });

    teardown(() => {
        (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = originalGetConfiguration;
        for (const name of PROXY_ENV_NAMES) {
            if (savedEnv[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = savedEnv[name];
            }
        }
    });

    async function seed(row: Row): Promise<void> {
        await harness.extensionContext.globalState.update('proxyState', { mode: ProxyMode.Auto, ...row.state });
        for (const [publicUrl, credentials] of Object.entries(row.credentials ?? {})) {
            harness.secrets.set(getCredentialKeyForPublicUrl(publicUrl), JSON.stringify(credentials));
        }
        if (row.legacy) {
            harness.secrets.set(LEGACY_MANUAL_PROXY_SECRET_KEY, row.legacy);
        }
        if (row.setting) {
            harness.settings.set('proxyUrl', row.setting);
        }
        if (row.processEnv) {
            process.env.HTTP_PROXY = row.processEnv;
        }
        reads.length = 0;
    }

    for (const row of ROWS) {
        test(row.name, async () => {
            await seed(row);

            const state = await harness.reload();

            assert.deepStrictEqual(state, { mode: ProxyMode.Auto, ...row.expected });
            if (row.reads) {
                assert.deepStrictEqual(reads, row.reads);
            }
        });
    }
});
