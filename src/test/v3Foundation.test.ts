import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../core/types';
import { deriveRuntimeApplyState, ProxyIssue, V3_SCHEMA_VERSION } from '../core/v3Types';
import { publicFingerprint, TargetOwnershipStore } from '../core/TargetOwnershipStore';
import { V3_MIGRATION_JOURNAL_KEY, V3_SCHEMA_VERSION_KEY, LEGACY_MANUAL_PROXY_SECRET_KEY } from '../core/V3MigrationService';
import { ProxyCredentialStore, splitProxyUrl, getCredentialKeyForPublicUrl } from '../security/ProxyCredentialStore';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { parseWinHttpShowProxy } from '../diagnostics/WindowsProxyDiagnostics';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';

type Store = Map<string, unknown>;

function createContext(store: Store, secrets: Map<string, string>): vscode.ExtensionContext {
    return {
        globalState: {
            get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
            },
            keys: () => [...store.keys()],
            setKeysForSync: () => {}
        },
        workspaceState: {
            get: () => undefined,
            update: async () => {},
            keys: () => [],
            setKeysForSync: () => {}
        },
        subscriptions: [],
        extensionPath: '',
        storagePath: undefined,
        globalStoragePath: '',
        logPath: '',
        extensionUri: vscode.Uri.file(''),
        storageUri: undefined,
        globalStorageUri: vscode.Uri.file(''),
        logUri: vscode.Uri.file(''),
        asAbsolutePath: (relativePath: string) => relativePath,
        environmentVariableCollection: new Map() as unknown as vscode.GlobalEnvironmentVariableCollection,
        extensionMode: vscode.ExtensionMode.Test,
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        } as unknown as vscode.SecretStorage,
        extension: {
            extensionKind: vscode.ExtensionKind.Workspace,
            packageJSON: { version: 'test' }
        } as unknown as vscode.Extension<unknown>,
        languageModelAccessInformation: {} as unknown
    } as vscode.ExtensionContext;
}

function stubConfiguration(proxyUrl: string, httpProxy?: string, proxySupport = 'on'): () => void {
    const original = vscode.workspace.getConfiguration;
    (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration =
        ((section?: string) => {
            if (section === 'otakProxy') {
                return {
                    get: (key: string, defaultValue?: unknown) => key === 'proxyUrl' ? proxyUrl : defaultValue,
                    update: async (key: string, value: unknown) => {
                        if (key === 'proxyUrl') {
                            proxyUrl = String(value ?? '');
                        }
                    },
                    inspect: () => undefined,
                    has: () => true
                } as unknown as vscode.WorkspaceConfiguration;
            }
            if (section === 'http') {
                return {
                    get: (key: string, defaultValue?: unknown) => {
                        if (key === 'proxy') {
                            return httpProxy;
                        }
                        if (key === 'proxySupport') {
                            return proxySupport;
                        }
                        if (key === 'noProxy') {
                            return [];
                        }
                        return defaultValue;
                    },
                    update: async () => {},
                    inspect: (key: string) => ({ globalValue: key === 'proxy' ? httpProxy : undefined }),
                    has: () => true
                } as unknown as vscode.WorkspaceConfiguration;
            }
            return original(section);
        }) as typeof vscode.workspace.getConfiguration;
    return () => {
        (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration = original;
    };
}

suite('v3 Phase 1 diagnostics foundation', () => {
    test('redacts URL, header, base64, npm token, stderr, and control-character secret forms', () => {
        const redactor = new ProxySecretRedactor();
        const secret = 's3cr3t!';
        const base64 = Buffer.from(`alice:${secret}`, 'utf8').toString('base64');
        const input = [
            `http://alice:${secret}@proxy.example.com:8080`,
            `Proxy-Authorization: Basic ${base64}`,
            `//registry.example/:_authToken=${secret}`,
            `stderr echoed ${encodeURIComponent(secret)}`,
            `bad\r\nnext`
        ].join('\n');

        const output = redactor.redactString(input, [secret, `alice:${secret}`]);
        assert.ok(!output.includes(secret));
        assert.ok(!output.includes(base64));
        assert.ok(!output.includes(encodeURIComponent(secret)));
        assert.ok(output.includes('\\r\\n'));
    });

    test('splits proxy credentials and reconstructs through SecretStorage without public leakage', async () => {
        const secrets = new Map<string, string>();
        const store = new ProxyCredentialStore({
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        } as unknown as vscode.SecretStorage);

        const split = splitProxyUrl('http://alice:s3cr3t@proxy.example.com:8080');
        const ref = await store.storeFromProxyUrl('http://alice:s3cr3t@proxy.example.com:8080');
        const reconstructed = await store.reconstructProxyUrl(split.publicUrl);

        assert.strictEqual(split.publicUrl, 'http://proxy.example.com:8080/');
        assert.ok(ref);
        assert.strictEqual(reconstructed, 'http://alice:s3cr3t@proxy.example.com:8080');
        assert.ok(!JSON.stringify({ publicUrl: split.publicUrl, ref }).includes('s3cr3t'));
    });

    test('migration stores v2 authenticated URL credentials in v3 SecretStorage and scrubs globalState', async () => {
        const persistedState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://alice:s3cr3t@proxy.example.com:8080'
        };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new Map<string, string>([[LEGACY_MANUAL_PROXY_SECRET_KEY, persistedState.manualProxyUrl!]]);
        const restoreConfig = stubConfiguration(persistedState.manualProxyUrl!, 'http://proxy.example.com:8080/');
        try {
            const manager = new ProxyStateManager(createContext(store, secrets));
            const state = await manager.getState();
            const storedState = store.get('proxyState') as ProxyState;

            assert.strictEqual(state.manualProxyUrl, 'http://alice:s3cr3t@proxy.example.com:8080');
            assert.strictEqual(storedState.manualProxyUrl, 'http://proxy.example.com:8080/');
            assert.strictEqual(store.get(V3_SCHEMA_VERSION_KEY), V3_SCHEMA_VERSION);
            assert.strictEqual((store.get(V3_MIGRATION_JOURNAL_KEY) as { phase: string }).phase, 'completed');
            assert.ok(!JSON.stringify([...store.entries()]).includes('s3cr3t'));
            assert.ok(!secrets.has(LEGACY_MANUAL_PROXY_SECRET_KEY));
            assert.ok([...secrets.values()].some(value => value.includes('s3cr3t')));
        } finally {
            restoreConfig();
        }
    });

    test('migration preserves every distinct credential-bearing URL (not only the first)', async () => {
        // Regression for #14: v2 users could hold differently-credentialed URLs in
        // more than one field. Migrating only the first and stripping the rest
        // silently discarded the other passwords.
        const persistedState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://alice:manualpass@manual.example.com:8080',
            fallbackProxyUrl: 'http://bob:fallbackpass@fallback.example.com:9090'
        };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new Map<string, string>();
        const restoreConfig = stubConfiguration('');
        try {
            const context = createContext(store, secrets);
            await new ProxyStateManager(context).getState();

            const credentialStore = new ProxyCredentialStore(context.secrets);
            const manualPublic = splitProxyUrl(persistedState.manualProxyUrl!).publicUrl;
            const fallbackPublic = splitProxyUrl(persistedState.fallbackProxyUrl!).publicUrl;

            assert.deepStrictEqual(
                await credentialStore.getCredentialsForPublicUrl(manualPublic),
                { username: 'alice', password: 'manualpass' },
                'manual URL credentials must be migrated'
            );
            assert.deepStrictEqual(
                await credentialStore.getCredentialsForPublicUrl(fallbackPublic),
                { username: 'bob', password: 'fallbackpass' },
                'fallback URL credentials must ALSO be migrated, not discarded'
            );

            // Both are reconstructable, and neither password remains in globalState.
            const persisted = JSON.stringify([...store.entries()]);
            assert.ok(!persisted.includes('manualpass'), 'manual password must not remain in globalState');
            assert.ok(!persisted.includes('fallbackpass'), 'fallback password must not remain in globalState');

            const journal = store.get(V3_MIGRATION_JOURNAL_KEY) as { phase: string; migratedCredentialRefs?: string[] };
            assert.strictEqual(journal.phase, 'completed');
            assert.strictEqual(journal.migratedCredentialRefs?.length, 2, 'journal must record both migrated credential refs');
        } finally {
            restoreConfig();
        }
    });

    test('migration records a dropped credential when two fields share a proxy address with different secrets', async () => {
        // Same public URL (host:port) but different credentials collide on one
        // secret key; the first wins and the loss is recorded in the journal.
        const persistedState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://alice:firstpass@shared.example.com:8080',
            fallbackProxyUrl: 'http://alice:secondpass@shared.example.com:8080'
        };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new Map<string, string>();
        const restoreConfig = stubConfiguration('');
        try {
            const context = createContext(store, secrets);
            await new ProxyStateManager(context).getState();

            const credentialStore = new ProxyCredentialStore(context.secrets);
            const sharedPublic = splitProxyUrl(persistedState.manualProxyUrl!).publicUrl;
            assert.deepStrictEqual(
                await credentialStore.getCredentialsForPublicUrl(sharedPublic),
                { username: 'alice', password: 'firstpass' },
                'the first (highest-priority) credential must win the shared address'
            );

            const journal = store.get(V3_MIGRATION_JOURNAL_KEY) as { droppedCredentialCount?: number };
            assert.strictEqual(journal.droppedCredentialCount, 1, 'the dropped distinct credential must be recorded');
        } finally {
            restoreConfig();
        }
    });

    test('a single malformed credential-bearing field does not abort migrating the valid ones', async () => {
        // hasProxyCredentials() accepts values that new URL() rejects (e.g. no host);
        // one such field must not fail the whole migration.
        const persistedState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://carol:goodpass@valid.example.com:8080',
            autoProxyUrl: 'http://mallory:badpass@'
        };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new Map<string, string>();
        const restoreConfig = stubConfiguration('');
        try {
            const context = createContext(store, secrets);
            await new ProxyStateManager(context).getState();

            const credentialStore = new ProxyCredentialStore(context.secrets);
            const validPublic = splitProxyUrl(persistedState.manualProxyUrl!).publicUrl;
            assert.deepStrictEqual(
                await credentialStore.getCredentialsForPublicUrl(validPublic),
                { username: 'carol', password: 'goodpass' },
                'the valid credential must still be migrated'
            );

            const journal = store.get(V3_MIGRATION_JOURNAL_KEY) as { phase: string };
            assert.strictEqual(journal.phase, 'completed', 'migration must complete despite the malformed field');
            assert.strictEqual(store.get(V3_SCHEMA_VERSION_KEY), V3_SCHEMA_VERSION);
        } finally {
            restoreConfig();
        }
    });

    test('two fields with the identical losing login count as one dropped credential', async () => {
        const persistedState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://alice:winner@shared.example.com:8080',
            lastSystemProxyUrl: 'http://alice:loser@shared.example.com:8080',
            fallbackProxyUrl: 'http://alice:loser@shared.example.com:8080'
        };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new Map<string, string>();
        const restoreConfig = stubConfiguration('');
        try {
            await new ProxyStateManager(createContext(store, secrets)).getState();
            const journal = store.get(V3_MIGRATION_JOURNAL_KEY) as { droppedCredentialCount?: number };
            assert.strictEqual(journal.droppedCredentialCount, 1, 'the same losing login must not be double-counted');
        } finally {
            restoreConfig();
        }
    });

    test('a partial SecretStorage failure preserves the other credential and is recorded', async () => {
        const manualUrl = 'http://alice:manualpass@manual.example.com:8080';
        const fallbackUrl = 'http://bob:fallbackpass@fallback.example.com:9090';
        const failingKey = getCredentialKeyForPublicUrl(splitProxyUrl(manualUrl).publicUrl);

        // A SecretStorage that rejects storing the manual credential but works otherwise.
        class PartiallyFailingSecrets extends Map<string, string> {
            set(key: string, value: string): this {
                if (key === failingKey) {
                    throw new Error('secret store failed');
                }
                return super.set(key, value);
            }
        }

        const persistedState: ProxyState = { mode: ProxyMode.Manual, manualProxyUrl: manualUrl, fallbackProxyUrl: fallbackUrl };
        const store: Store = new Map([['proxyState', persistedState]]);
        const secrets = new PartiallyFailingSecrets();
        const restoreConfig = stubConfiguration('');
        try {
            const context = createContext(store, secrets);
            await new ProxyStateManager(context).getState();

            const credentialStore = new ProxyCredentialStore(context.secrets);
            assert.strictEqual(
                await credentialStore.getCredentialsForPublicUrl(splitProxyUrl(manualUrl).publicUrl),
                undefined,
                'the credential whose store failed must not be present'
            );
            assert.deepStrictEqual(
                await credentialStore.getCredentialsForPublicUrl(splitProxyUrl(fallbackUrl).publicUrl),
                { username: 'bob', password: 'fallbackpass' },
                'the other credential must still be migrated despite the partial failure'
            );

            const journal = store.get(V3_MIGRATION_JOURNAL_KEY) as { phase: string; lastErrorSanitized?: string };
            assert.strictEqual(journal.phase, 'completed');
            assert.ok(journal.lastErrorSanitized, 'a partial SecretStorage failure must be recorded in the journal');
        } finally {
            restoreConfig();
        }
    });

    test('secret-bearing ownership is not trusted when HMAC fingerprint is missing', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const credentialStore = new ProxyCredentialStore(createContext(store, secrets).secrets);
        const ownershipStore = new TargetOwnershipStore(createContext(store, secrets).globalState, credentialStore);

        await ownershipStore.update({
            targetId: 'git.global.http.proxy',
            targetHost: 'workspaceHost',
            owner: 'otakProxy',
            publicFingerprint: publicFingerprint('http://proxy.example.com:8080/')
        });

        assert.strictEqual(
            await ownershipStore.isOwnedByOtakProxy('git.global.http.proxy', 'http://proxy.example.com:8080/', true),
            false
        );
    });

    test('runtime state separates advisory issues from convergence blockers', () => {
        const advisory: ProxyIssue = {
            id: 'terminal.existing',
            fingerprint: 'terminal.existing',
            category: 'needsNewTerminal',
            impact: 'advisoryResidualRisk',
            targetId: 'terminal.existing',
            targetHost: 'workspaceHost',
            source: 'test',
            capability: 'readOnly',
            autoAction: 'none',
            userAction: 'openNewTerminal',
            evidence: {}
        };
        const blocking = { ...advisory, id: 'npm.timeout', category: 'applyFailed', impact: 'blocksConvergence' } as ProxyIssue;

        assert.strictEqual(deriveRuntimeApplyState([advisory], true, 2, 2), 'applied');
        assert.strictEqual(deriveRuntimeApplyState([blocking], true, 1, 2), 'partial');
    });

    test('parses English and Japanese WinHTTP fixture output without mutating Windows settings', () => {
        const english = parseWinHttpShowProxy('Current WinHTTP proxy settings:\r\n    Proxy Server(s) : proxy.example.com:8080\r\n    Bypass List     : <local>\r\n');
        const japanese = parseWinHttpShowProxy('現在の WinHTTP プロキシ設定:\r\n    プロキシ サーバー: proxy.example.com:8080\r\n    バイパス一覧: <local>\r\n');

        assert.strictEqual(english.winHttpProxy, 'proxy.example.com:8080');
        assert.strictEqual(japanese.winHttpProxy, 'proxy.example.com:8080');
        assert.strictEqual(parseWinHttpShowProxy('unrecognized output').winHttpParseStatus, 'parseUnavailable');
    });

    test('ProxyRuntimeDiagnostics reports multiple sanitized read-only issues', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', 'http://alice:s3cr3t@proxy.example.com:8080', 'off');
        const originalHttpProxy = process.env.HTTP_PROXY;
        process.env.HTTP_PROXY = 'http://alice:s3cr3t@proxy.example.com:8080';
        const calls: Array<{ command: string; args: string[] }> = [];
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({ mode: ProxyMode.Manual, manualProxyUrl: 'http://alice:s3cr3t@proxy.example.com:8080' }),
                {
                    commandRunner: async (command, args) => {
                        calls.push({ command, args });
                        if (command === 'git') {
                            return { stdout: args.includes('--get-regexp') ? 'remote.origin.proxy http://other.example:8080\n' : '', stderr: '' };
                        }
                        if (args.includes('noproxy')) {
                            return { stdout: '.example.com\n', stderr: '' };
                        }
                        if (args.includes('registry')) {
                            return { stdout: 'https://registry.npmjs.org/\n', stderr: '' };
                        }
                        return { stdout: 'undefined\n', stderr: '' };
                    }
                }
            );

            const report = await diagnostics.run();
            const serialized = JSON.stringify(report);
            assert.ok(report.issues.some(issue => issue.id === 'vscode.proxySupport.off'));
            assert.ok(report.issues.some(issue => issue.id === 'terminal.inheritedProxyEnv'));
            assert.ok(report.issues.some(issue => issue.id === 'git.effectiveOverride'));
            assert.ok(report.issues.some(issue => issue.id === 'npm.noproxy'));
            assert.ok(!serialized.includes('s3cr3t'));
            assert.ok(!calls.some(call => call.args.includes('set') || call.args.includes('delete')));
        } finally {
            if (originalHttpProxy === undefined) {
                delete process.env.HTTP_PROXY;
            } else {
                process.env.HTTP_PROXY = originalHttpProxy;
            }
            restoreConfig();
        }
    });

    test('ProxyRuntimeDiagnostics reports managed residual proxies when Auto is off', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', 'http://vscode.example.com:8080', 'on');
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({
                    mode: ProxyMode.Auto,
                    autoModeOff: true,
                    gitConfigured: false,
                    npmConfigured: false,
                    vscodeConfigured: false
                }),
                {
                    commandRunner: async (command, args) => {
                        if (command === 'git' && args.includes('http.proxy')) {
                            return { stdout: 'http://git.example.com:8080\n', stderr: '' };
                        }
                        if (command === 'git') {
                            return { stdout: '', stderr: '' };
                        }
                        if (command === 'netsh') {
                            return { stdout: 'Current WinHTTP proxy settings:\r\n    Direct access (no proxy server).\r\n', stderr: '' };
                        }
                        if (command === 'reg') {
                            return { stdout: '', stderr: '' };
                        }
                        if (args.includes('proxy') || args.includes('https-proxy')) {
                            return { stdout: 'http://npm.example.com:8080\n', stderr: '' };
                        }
                        if (args.includes('registry')) {
                            return { stdout: 'https://registry.npmjs.org/\n', stderr: '' };
                        }
                        return { stdout: 'undefined\n', stderr: '' };
                    }
                }
            );

            const report = await diagnostics.run();
            const issueIds = new Set(report.issues.map(issue => issue.id));
            assert.ok(issueIds.has('git.managedProxyResidual'));
            assert.ok(issueIds.has('npm.managedProxyResidual'));
            assert.ok(issueIds.has('vscode.managedProxyResidual'));
            assert.strictEqual(report.highestPriorityCategory, 'applyFailed');
            assert.ok(report.issues.every(issue => issue.capability === 'readOnly'));
        } finally {
            restoreConfig();
        }
    });

    test('ProxyRuntimeDiagnostics reports managed proxy mismatches when Auto is on', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', 'http://stale.example.com:8080', 'on');
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({
                    mode: ProxyMode.Auto,
                    autoProxyUrl: 'http://expected.example.com:8080',
                    autoModeOff: false,
                    gitConfigured: true,
                    npmConfigured: true,
                    vscodeConfigured: true
                }),
                {
                    commandRunner: async (command, args) => {
                        if (command === 'git' && (args.includes('http.proxy') || args.includes('https.proxy'))) {
                            return { stdout: 'http://stale.example.com:8080\n', stderr: '' };
                        }
                        if (command === 'git') {
                            return { stdout: '', stderr: '' };
                        }
                        if (command === 'netsh') {
                            return { stdout: 'Current WinHTTP proxy settings:\r\n    Direct access (no proxy server).\r\n', stderr: '' };
                        }
                        if (command === 'reg') {
                            return { stdout: '', stderr: '' };
                        }
                        if (args.includes('proxy') || args.includes('https-proxy')) {
                            return { stdout: 'http://stale.example.com:8080\n', stderr: '' };
                        }
                        if (args.includes('registry')) {
                            return { stdout: 'https://registry.npmjs.org/\n', stderr: '' };
                        }
                        return { stdout: 'undefined\n', stderr: '' };
                    }
                }
            );

            const report = await diagnostics.run();
            const issueIds = new Set(report.issues.map(issue => issue.id));
            assert.ok(issueIds.has('git.managedProxyMismatch'));
            assert.ok(issueIds.has('npm.managedProxyMismatch'));
            assert.ok(issueIds.has('vscode.managedProxyMismatch'));
            assert.strictEqual(report.highestPriorityCategory, 'applyFailed');
            assert.ok(report.issues.every(issue => issue.capability === 'readOnly'));
        } finally {
            restoreConfig();
        }
    });

    test('ProxyRuntimeDiagnostics issue fingerprints are stable across restarts (no process id)', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', 'http://vscode.example.com:8080', 'on');
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({
                    mode: ProxyMode.Auto,
                    autoModeOff: true,
                    gitConfigured: false,
                    npmConfigured: false,
                    vscodeConfigured: false
                }),
                {
                    commandRunner: async (command, args) => {
                        if (command === 'git' && args.includes('http.proxy')) {
                            return { stdout: 'http://git.example.com:8080\n', stderr: '' };
                        }
                        return { stdout: '', stderr: '' };
                    }
                }
            );

            const report = await diagnostics.run();
            assert.ok(report.issues.length > 0, 'scenario must produce at least one issue');
            for (const issue of report.issues) {
                // The fingerprint keys the cross-window notification cooldown in
                // globalState; embedding the PID resets the cooldown on every
                // reload and leaks one orphaned record per restart.
                assert.ok(
                    !issue.fingerprint.includes(`pid-${process.pid}`),
                    `fingerprint must not embed the process id: ${issue.fingerprint}`
                );
            }
        } finally {
            restoreConfig();
        }
    });

    test('ProxyRuntimeDiagnostics reads git and npm config concurrently (keeps the locked critical section short)', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', undefined, 'on');
        const inFlight = { git: 0, npm: 0 };
        const maxInFlight = { git: 0, npm: 0 };
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({ mode: ProxyMode.Manual, manualProxyUrl: 'http://proxy.example.com:8080' }),
                {
                    commandRunner: async (command, _args) => {
                        const family = command === 'git'
                            ? 'git' as const
                            : (command === 'netsh' || command === 'reg') ? undefined : 'npm' as const;
                        if (family) {
                            inFlight[family] += 1;
                            maxInFlight[family] = Math.max(maxInFlight[family], inFlight[family]);
                        }
                        await new Promise(resolve => setTimeout(resolve, 25));
                        if (family) {
                            inFlight[family] -= 1;
                        }
                        return { stdout: '', stderr: '' };
                    }
                }
            );

            await diagnostics.run({ bypassSlowCache: true });

            assert.ok(maxInFlight.git >= 2, `git config reads must overlap, saw max in-flight ${maxInFlight.git}`);
            assert.ok(maxInFlight.npm >= 2, `npm config reads must overlap, saw max in-flight ${maxInFlight.npm}`);
        } finally {
            restoreConfig();
        }
    });

    test('ProxyRuntimeDiagnostics caches slow command diagnostics within the configured TTL', async () => {
        const store: Store = new Map();
        const secrets = new Map<string, string>();
        const context = createContext(store, secrets);
        const restoreConfig = stubConfiguration('', undefined, 'on');
        let commandCalls = 0;
        try {
            const diagnostics = new ProxyRuntimeDiagnostics(
                context,
                async () => ({ mode: ProxyMode.Manual, manualProxyUrl: 'http://proxy.example.com:8080' }),
                {
                    commandRunner: async (_command, args) => {
                        commandCalls += 1;
                        if (args.includes('registry')) {
                            return { stdout: 'https://registry.npmjs.org/\n', stderr: '' };
                        }
                        return { stdout: 'undefined\n', stderr: '' };
                    }
                }
            );

            await diagnostics.run();
            const callsAfterFirstRun = commandCalls;
            await diagnostics.run();

            assert.ok(callsAfterFirstRun > 0);
            assert.strictEqual(commandCalls, callsAfterFirstRun);
        } finally {
            restoreConfig();
        }
    });
});
