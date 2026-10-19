import * as assert from 'assert';
import type * as vscode from 'vscode';
import { ProxyApplier } from '../core/ProxyApplier';
import { TargetOwnershipStore } from '../core/TargetOwnershipStore';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import type { GitConfigManager, GitProxyKey } from '../config/GitConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import type { NpmProxyKey } from '../config/NpmConfigManager';
import type { VscodeConfigManager } from '../config/VscodeConfigManager';
import type { PipConfigManager } from '../config/PipConfigManager';
import type { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import type { UserNotifier } from '../errors/UserNotifier';
import { createFakeNpmConfig, FakeNpmConfig } from './fakeConfigStores';

interface FakeTargetSet {
    git: FakeGitManager;
    npm: FakeNpmManager;
    vscode: FakeSingleManager;
    pip: FakeSingleManager;
    terminal: FakeTerminalManager;
}

class FakeGitManager {
    values: Record<GitProxyKey, string | string[] | null> = { 'http.proxy': null, 'https.proxy': null };
    unsetCalls: GitProxyKey[][] = [];
    expectedValueCalls: Array<Partial<Record<GitProxyKey, string>> | undefined> = [];

    private list(key: GitProxyKey): string[] {
        const value = this.values[key];
        if (value === null || value === undefined) {
            return [];
        }
        return Array.isArray(value) ? value : [value];
    }

    private first(key: GitProxyKey): string | null {
        return this.list(key)[0] ?? null;
    }

    async setProxy(url: string) {
        this.values['http.proxy'] = url;
        this.values['https.proxy'] = url;
        return { success: true };
    }
    async unsetProxy() { return this.unsetProxyKeys(['http.proxy', 'https.proxy']); }
    async unsetProxyKeys(
        keys: readonly GitProxyKey[],
        options?: {
            exactValues?: Partial<Record<GitProxyKey, readonly string[]>>;
            expectedValues?: Readonly<Partial<Record<GitProxyKey, string>>>;
        }
    ) {
        this.unsetCalls.push([...keys]);
        this.expectedValueCalls.push(options?.expectedValues ? { ...options.expectedValues } : undefined);
        const preservedKeys: GitProxyKey[] = [];
        for (const key of keys) {
            const exact = options?.exactValues?.[key];
            const expected = options?.expectedValues?.[key];
            if (exact && exact.length > 0) {
                const remaining = this.list(key).filter(value => !exact.includes(value));
                this.values[key] = remaining.length === 0 ? null : remaining.length === 1 ? remaining[0] : remaining;
                if (remaining.length > 0) {
                    preservedKeys.push(key);
                }
                continue;
            }
            if (expected !== undefined) {
                const remaining = this.list(key).filter(value => value !== expected);
                if (!this.list(key).includes(expected)) {
                    if (remaining.length > 0) {
                        preservedKeys.push(key);
                    }
                    continue;
                }
                this.values[key] = remaining.length === 0 ? null : remaining.length === 1 ? remaining[0] : remaining;
                if (remaining.length > 0) {
                    preservedKeys.push(key);
                }
                continue;
            }
            if (this.list(key).length > 1) {
                return { success: false, error: 'Git key has multiple values', errorType: 'CONFIG_ERROR' };
            }
            this.values[key] = null;
        }
        return preservedKeys.length > 0
            ? { success: true, preservedKeys }
            : { success: true };
    }
    async inspectProxy(): Promise<{
        status: 'available' | 'unavailable' | 'error';
        values?: Record<GitProxyKey, string | null>;
        allValues?: Record<GitProxyKey, string[]>;
        error?: string;
        errorType?: string;
    }> {
        return {
            status: 'available',
            values: { 'http.proxy': this.first('http.proxy'), 'https.proxy': this.first('https.proxy') },
            allValues: { 'http.proxy': this.list('http.proxy'), 'https.proxy': this.list('https.proxy') }
        };
    }
}

class FakeNpmManager {
    values: Record<NpmProxyKey, string | null> = { proxy: null, 'https-proxy': null };
    unsetCalls: NpmProxyKey[][] = [];

    async setProxy(url: string) {
        this.values.proxy = url;
        this.values['https-proxy'] = url;
        return { success: true };
    }
    async unsetProxy() { return this.unsetProxyKeys(['proxy', 'https-proxy']); }
    async unsetProxyKeys(
        keys: readonly NpmProxyKey[],
        expectedValues?: Readonly<Partial<Record<NpmProxyKey, string>>>
    ) {
        this.unsetCalls.push([...keys]);
        const preservedKeys: NpmProxyKey[] = [];
        for (const key of keys) {
            const expected = expectedValues?.[key];
            if (expected !== undefined && this.values[key] !== expected) {
                preservedKeys.push(key);
                continue;
            }
            this.values[key] = null;
        }
        return preservedKeys.length > 0
            ? { success: true, preservedKeys }
            : { success: true };
    }
    async inspectProxy() { return { status: 'available' as const, values: { ...this.values } }; }
    async inspectOwnedProxy() {
        return { status: 'available' as const, values: { ...this.values }, externalValueLoaded: false };
    }
}

class FakeSingleManager {
    value: string | null = null;
    unsetCount = 0;

    async setProxy(url: string) { this.value = url; return { success: true }; }
    async unsetProxy(options?: { expectedValue?: string }) {
        this.unsetCount++;
        const expectedValue = options?.expectedValue;
        if (expectedValue !== undefined && this.value !== expectedValue) {
            return { success: true, preservedKeys: ['proxy'] };
        }
        this.value = null;
        return { success: true };
    }
    async inspectProxy() { return { status: 'available' as const, values: { proxy: this.value } }; }
}

class FakeTerminalManager {
    value: string | null = null;
    unsetCount = 0;
    async setProxy(url: string) { this.value = url; return { success: true }; }
    async unsetProxy() { this.unsetCount++; this.value = null; return { success: true }; }
}

function createOwnershipHarness(): { store: TargetOwnershipStore; secrets: Map<string, string> } {
    const values = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const memento = {
        get: <T>(key: string, defaultValue?: T) => (values.has(key) ? values.get(key) : defaultValue) as T,
        update: async (key: string, value: unknown) => { values.set(key, value); },
        keys: () => [...values.keys()],
        setKeysForSync: () => {}
    } as vscode.Memento;
    const secretStorage = {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
        onDidChange: () => ({ dispose: () => {} })
    } as vscode.SecretStorage;
    return { store: new TargetOwnershipStore(memento, new ProxyCredentialStore(secretStorage)), secrets };
}

function createOwnershipStore(): TargetOwnershipStore {
    return createOwnershipHarness().store;
}

interface NotifierCalls {
    successes: string[];
    warnings: Array<{ message: string; params?: Record<string, string> }>;
    errors: string[];
}

function createRecordingNotifier(): { notifier: UserNotifier; calls: NotifierCalls } {
    const calls: NotifierCalls = { successes: [], warnings: [], errors: [] };
    const notifier = {
        showSuccess: (message: string) => { calls.successes.push(message); },
        showWarning: (message: string, params?: Record<string, string>) => { calls.warnings.push({ message, params }); },
        showError: (message: string) => { calls.errors.push(message); }
    } as unknown as UserNotifier;
    return { notifier, calls };
}

function createTargets(): FakeTargetSet {
    return {
        git: new FakeGitManager(),
        npm: new FakeNpmManager(),
        vscode: new FakeSingleManager(),
        pip: new FakeSingleManager(),
        terminal: new FakeTerminalManager()
    };
}

function createApplier(
    targets: FakeTargetSet,
    ownershipStore: TargetOwnershipStore,
    notifier: UserNotifier = createRecordingNotifier().notifier
): ProxyApplier {
    return new ProxyApplier(
        targets.git as unknown as GitConfigManager,
        targets.vscode as unknown as VscodeConfigManager,
        targets.npm as unknown as NpmConfigManager,
        new ProxyUrlValidator(),
        new InputSanitizer(),
        notifier,
        undefined,
        targets.terminal as unknown as TerminalEnvConfigManager,
        targets.pip as unknown as PipConfigManager,
        ownershipStore
    );
}

/** The production npm manager over the fake npm CLI, which refuses credentialed `config get` like npm 11. */
function createRealNpmTarget(npm: FakeNpmConfig, readUserConfigFile = npm.readUserConfigFile): FakeNpmManager {
    return new NpmConfigManager(undefined, {
        isWindows: false,
        env: {},
        commandAvailable: () => true,
        commandRunner: npm.runner,
        readUserConfigFile
    }) as unknown as FakeNpmManager;
}

suite('Ownership-safe proxy disable integration', () => {
    suite('Off names the values it kept because ownership could not be verified (#108)', () => {
        const CREDENTIALED = 'http://alice:s3cret@proxy.example.com:8080';

        test('a lost HMAC key keeps the Git value and the warning names the target by its label', async () => {
            const harness = createOwnershipHarness();
            const targets = createTargets();
            const { notifier, calls } = createRecordingNotifier();
            const applier = createApplier(targets, harness.store, notifier);
            assert.strictEqual((await applier.applyProxyDetailed(CREDENTIALED, true, { silent: true })).success, true);

            harness.secrets.clear();
            const disabled = await applier.disableProxyDetailed();

            assert.strictEqual(targets.git.values['http.proxy'], CREDENTIALED, 'an unverifiable value is kept');
            assert.deepStrictEqual(targets.git.unsetCalls, []);
            assert.strictEqual(disabled.results.gitOutcome, 'ownershipUnverified');
            assert.ok(disabled.results.unverifiedTargetIds?.includes('git.global.http.proxy'));
            assert.deepStrictEqual(calls.successes, [], 'no "proxy disabled" while a value is still there');
            assert.strictEqual(calls.warnings.length, 1);
            assert.strictEqual(calls.warnings[0].message, 'warning.proxyOffUnverified');
            assert.ok(calls.warnings[0].params?.targets.includes('Git global http.proxy'), calls.warnings[0].params?.targets);
            assert.ok(!calls.warnings[0].params?.targets.includes('git.global.http.proxy'), 'a label, not the raw id');
            assert.ok(!JSON.stringify(calls).includes('s3cret'));
        });

        test('a value the user set after otak-proxy wrote its own stays preservedExternal, not unverified', async () => {
            const harness = createOwnershipHarness();
            const targets = createTargets();
            const { notifier, calls } = createRecordingNotifier();
            const applier = createApplier(targets, harness.store, notifier);
            assert.strictEqual((await applier.applyProxyDetailed(CREDENTIALED, true, { silent: true })).success, true);

            targets.git.values['http.proxy'] = 'http://alice:other@proxy.example.com:8080';
            const disabled = await applier.disableProxyDetailed();

            assert.strictEqual(disabled.results.gitOutcome, 'preservedExternal');
            assert.deepStrictEqual(calls.warnings, []);
            assert.deepStrictEqual(calls.successes, ['message.proxyDisabled']);
        });

        test('a credential-free value is verified without the HMAC key and is cleared', async () => {
            const harness = createOwnershipHarness();
            const targets = createTargets();
            const { notifier, calls } = createRecordingNotifier();
            const applier = createApplier(targets, harness.store, notifier);
            assert.strictEqual((await applier.applyProxyDetailed('http://proxy.example.com:8080', true, { silent: true })).success, true);

            // The fake also fills the legacy https.proxy key, which otak-proxy no longer records.
            targets.git.values['https.proxy'] = null;
            harness.secrets.clear();
            const disabled = await applier.disableProxyDetailed();

            assert.strictEqual(disabled.results.gitOutcome, 'cleared');
            assert.deepStrictEqual(calls.warnings, []);
            assert.deepStrictEqual(calls.successes, ['message.proxyDisabled']);
        });
    });

    suite('npm Off reads only the user layer (#108)', () => {
        const OWNED = 'http://proxy.example.com:8080';

        async function applyThenOff(npm: FakeNpmConfig) {
            const { notifier, calls } = createRecordingNotifier();
            const targets = { ...createTargets(), npm: createRealNpmTarget(npm) };
            const applier = createApplier(targets, createOwnershipStore(), notifier);
            const applied = await applier.applyProxyDetailed(OWNED, true, { silent: true });
            const disabled = await applier.disableProxyDetailed();
            return { applied, disabled, calls };
        }

        test('the same value in the user and the global layer: the user value is removed, the global one stays, Off is not an error', async () => {
            const npm = createFakeNpmConfig({}, { global: { proxy: OWNED, 'https-proxy': OWNED } });
            const { applied, disabled, calls } = await applyThenOff(npm);

            assert.strictEqual(applied.success, true, JSON.stringify(applied.errors));
            assert.strictEqual(npm.get('proxy'), null);
            assert.strictEqual(npm.get('https-proxy'), null);
            assert.strictEqual(npm.getGlobal('proxy'), OWNED);
            assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
            assert.strictEqual(disabled.results.npmOutcome, 'preservedExternal');
            assert.deepStrictEqual(calls.errors, []);
            assert.deepStrictEqual(calls.successes, ['message.proxyDisabled']);
        });

        test('a value that exists only in the global layer is preserved without an error', async () => {
            const npm = createFakeNpmConfig({}, { global: { proxy: OWNED } });
            const { notifier, calls } = createRecordingNotifier();
            const targets = { ...createTargets(), npm: createRealNpmTarget(npm) };
            const disabled = await createApplier(targets, createOwnershipStore(), notifier).disableProxyDetailed();

            assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
            assert.strictEqual(disabled.results.npmOutcome, 'preservedExternal');
            assert.strictEqual(npm.getGlobal('proxy'), OWNED);
            assert.deepStrictEqual(calls.errors, []);
        });

        test('a credentialed value that only the global layer holds is preserved and its password never appears', async () => {
            const credentialed = 'http://alice:s3cret@proxy.example.com:8080';
            const npm = createFakeNpmConfig({}, { global: { 'https-proxy': credentialed } });
            const { notifier, calls } = createRecordingNotifier();
            const targets = { ...createTargets(), npm: createRealNpmTarget(npm) };
            const disabled = await createApplier(targets, createOwnershipStore(), notifier).disableProxyDetailed();

            assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
            assert.strictEqual(disabled.results.npmOutcome, 'preservedExternal');
            assert.ok(!JSON.stringify([disabled, calls]).includes('s3cret'));
        });

        test('no user config file: Off has nothing to remove and is clean', async () => {
            const npm = createFakeNpmConfig({}, { missingUserConfigFile: true });
            const { notifier } = createRecordingNotifier();
            const targets = { ...createTargets(), npm: createRealNpmTarget(npm) };
            const disabled = await createApplier(targets, createOwnershipStore(), notifier).disableProxyDetailed();

            assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
            assert.strictEqual(disabled.results.npmOutcome, 'cleared');
        });

        test('a user config path npm will not name falls back to the merged read and still removes the owned value', async () => {
            const npm = createFakeNpmConfig({}, { emptyUserConfigPath: true });
            const { applied, disabled } = await applyThenOff(npm);

            assert.strictEqual(applied.success, true, JSON.stringify(applied.errors));
            assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
            assert.strictEqual(disabled.results.npmOutcome, 'cleared');
            assert.strictEqual(npm.get('proxy'), null);
        });

        test('npm not installed is skipped, not failed', async () => {
            const npm = createFakeNpmConfig();
            const { notifier } = createRecordingNotifier();
            const manager = new NpmConfigManager(undefined, {
                isWindows: false,
                env: {},
                commandAvailable: () => false,
                commandRunner: npm.runner,
                readUserConfigFile: npm.readUserConfigFile
            });
            const targets = { ...createTargets(), npm: manager as unknown as FakeNpmManager };
            const disabled = await createApplier(targets, createOwnershipStore(), notifier).disableProxyDetailed();

            assert.strictEqual(disabled.results.npmOutcome, 'skippedUnavailable');
        });
    });

    test('Auto then Off writes and removes a credentialed npm proxy (#85)', async () => {
        const npm = createFakeNpmConfig();
        const targets = { ...createTargets(), npm: createRealNpmTarget(npm) };
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://alice:s3cret@proxy.example.com:8080';

        const applied = await applier.applyProxyDetailed(proxyUrl, true, { silent: true });
        assert.strictEqual(applied.success, true, JSON.stringify(applied.errors));
        assert.strictEqual(npm.get('proxy'), proxyUrl);
        assert.strictEqual(npm.get('https-proxy'), proxyUrl);

        const disabled = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(disabled.success, true, JSON.stringify(disabled.errors));
        assert.strictEqual(disabled.results.npmOutcome, 'cleared');
        assert.strictEqual(npm.get('proxy'), null);
        assert.strictEqual(npm.get('https-proxy'), null);
    });

    test('Off keeps a credentialed npm proxy it cannot verify (#85)', async () => {
        const npm = createFakeNpmConfig();
        let userConfigReadable = true;
        const targets = {
            ...createTargets(),
            npm: createRealNpmTarget(npm, async path => {
                if (!userConfigReadable) {
                    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                }
                return npm.readUserConfigFile(path);
            })
        };
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://alice:s3cret@proxy.example.com:8080';
        assert.strictEqual((await applier.applyProxyDetailed(proxyUrl, true, { silent: true })).success, true);

        userConfigReadable = false;
        const disabled = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(disabled.success, false);
        assert.strictEqual(disabled.results.npmOutcome, 'failed');
        assert.strictEqual(npm.get('proxy'), proxyUrl);
        assert.strictEqual(npm.get('https-proxy'), proxyUrl);
        assert.ok(!JSON.stringify(disabled).includes('s3cret'));
    });

    test('Off removes an uncompensated first-key residual after a failed Git setProxy', async () => {
        const targets = createTargets();
        const ownedUrl = 'http://partial.example:8080';
        targets.git.setProxy = async (url: string) => {
            targets.git.values['http.proxy'] = url;
            return {
                success: false,
                error: 'https.proxy write failed; residual remains: http.proxy',
                errorType: 'UNKNOWN',
                residualKeys: ['http.proxy']
            };
        };
        const applier = createApplier(targets, createOwnershipStore());

        const applied = await applier.applyProxyDetailed(ownedUrl, true, { silent: true });
        assert.strictEqual(applied.success, false);
        assert.strictEqual(targets.git.values['http.proxy'], ownedUrl);

        const disabled = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(disabled.success, true);
        assert.strictEqual(targets.git.values['http.proxy'], null);
        assert.deepStrictEqual(targets.git.unsetCalls, [['http.proxy']]);
    });

    test('clears only keys whose current values still match otak-proxy fingerprints', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://token_only_secret@proxy.example.com:8080';
        assert.strictEqual((await applier.applyProxyDetailed(proxyUrl, true, { silent: true })).success, true);

        targets.git.values['https.proxy'] = 'http://external-git.example:3128';
        targets.npm.values.proxy = 'http://external-npm.example:3128';

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(targets.git.unsetCalls, [['http.proxy']]);
        assert.strictEqual(targets.git.values['http.proxy'], null);
        assert.strictEqual(targets.git.values['https.proxy'], 'http://external-git.example:3128');
        assert.deepStrictEqual(targets.npm.unsetCalls, [['https-proxy']]);
        assert.strictEqual(targets.npm.values.proxy, 'http://external-npm.example:3128');
        assert.strictEqual(targets.npm.values['https-proxy'], null);
        assert.strictEqual(targets.vscode.value, null);
        assert.strictEqual(targets.pip.value, null);
        assert.strictEqual(targets.terminal.value, null);
        assert.strictEqual(result.results.gitOutcome, 'preservedExternal');
        assert.strictEqual(result.results.npmOutcome, 'preservedExternal');
        assert.strictEqual(result.results.vscodeOutcome, 'cleared');
        assert.strictEqual(result.results.pipOutcome, 'cleared');
    });

    test('preserves every pre-existing external value when there is no ownership record', async () => {
        const targets = createTargets();
        targets.git.values = {
            'http.proxy': 'http://external.example:8080',
            'https.proxy': 'http://external.example:8080'
        };
        targets.npm.values = {
            proxy: 'http://external.example:8080',
            'https-proxy': 'http://external.example:8080'
        };
        targets.vscode.value = 'http://external.example:8080';
        targets.pip.value = 'http://external.example:8080';
        const applier = createApplier(targets, createOwnershipStore());

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(targets.git.unsetCalls, []);
        assert.deepStrictEqual(targets.npm.unsetCalls, []);
        assert.strictEqual(targets.vscode.unsetCount, 0);
        assert.strictEqual(targets.pip.unsetCount, 0);
        assert.strictEqual(targets.terminal.unsetCount, 1, 'extension-owned terminal collection remains safe to clear');
        assert.strictEqual(result.results.gitOutcome, 'preservedExternal');
        assert.strictEqual(result.results.vscodeOutcome, 'preservedExternal');
    });

    test('treats an unavailable optional target as skipped without deleting blindly', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        await applier.applyProxyDetailed('http://proxy.example:8080', true, { silent: true });
        (targets.git as unknown as { inspectProxy(): Promise<unknown> }).inspectProxy = async () => ({
            status: 'unavailable',
            error: 'git is not installed',
            errorType: 'NOT_INSTALLED'
        });

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.results.gitOutcome, 'skippedUnavailable');
        assert.deepStrictEqual(targets.git.unsetCalls, []);
        assert.ok(targets.git.values['http.proxy']);
    });

    test('fails closed on target inspection errors and keeps the current value', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        await applier.applyProxyDetailed('http://proxy.example:8080', true, { silent: true });
        (targets.git as { inspectProxy(): Promise<unknown> }).inspectProxy = async () => ({
            status: 'error',
            error: 'permission denied',
            errorType: 'NO_PERMISSION'
        });

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.results.gitOutcome, 'failed');
        assert.deepStrictEqual(targets.git.unsetCalls, []);
        assert.ok(targets.git.values['http.proxy']);
        assert.ok(result.errors.some(error => error.message.includes('permission denied')));
    });

    test('drops stale ownership for absent values so an equal future external value is preserved', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://proxy.example:8080';
        await applier.applyProxyDetailed(proxyUrl, true, { silent: true });
        targets.git.values = { 'http.proxy': null, 'https.proxy': null };

        const firstDisable = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(firstDisable.results.gitOutcome, 'cleared');
        assert.deepStrictEqual(targets.git.unsetCalls, []);

        targets.git.values = { 'http.proxy': proxyUrl, 'https.proxy': proxyUrl };
        const secondDisable = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(secondDisable.results.gitOutcome, 'preservedExternal');
        assert.deepStrictEqual(targets.git.unsetCalls, []);
    });

    test('recovers idempotently after an interrupted multi-key cleanup', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://proxy.example:8080';
        await applier.applyProxyDetailed(proxyUrl, true, { silent: true });
        const normalUnset = targets.git.unsetProxyKeys.bind(targets.git);
        let interruptOnce = true;
        targets.git.unsetProxyKeys = async keys => {
            if (interruptOnce) {
                interruptOnce = false;
                targets.git.unsetCalls.push([...keys]);
                targets.git.values['http.proxy'] = null;
                return { success: false, error: 'interrupted write', errorType: 'CONFIG_ERROR' };
            }
            return normalUnset(keys);
        };

        const interrupted = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(interrupted.success, false);
        assert.strictEqual(targets.git.values['http.proxy'], null);
        assert.strictEqual(targets.git.values['https.proxy'], proxyUrl);

        const recovered = await applier.disableProxyDetailed({ silent: true });
        assert.strictEqual(recovered.success, true);
        assert.strictEqual(recovered.results.gitOutcome, 'cleared');
        assert.strictEqual(targets.git.values['https.proxy'], null);
        assert.deepStrictEqual(targets.git.unsetCalls, [
            ['http.proxy', 'https.proxy'],
            ['https.proxy']
        ]);
    });

    test('clears only the owned Git multi-value and leaves the external value', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        const proxyUrl = 'http://proxy.example:8080';
        const externalUrl = 'http://external.example:8080';
        assert.strictEqual((await applier.applyProxyDetailed(proxyUrl, true, { silent: true })).success, true);

        targets.git.values['http.proxy'] = [proxyUrl, externalUrl];

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(targets.git.unsetCalls, [['http.proxy', 'https.proxy']]);
        assert.deepStrictEqual(targets.git.values['http.proxy'], externalUrl);
        assert.strictEqual(targets.git.values['https.proxy'], null);
        assert.strictEqual(result.results.gitOutcome, 'preservedExternal');
    });

    test('keeps an external value written after ownership was confirmed and before unset', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        const ownedUrl = 'http://owned.example:8080';
        const externalUrl = 'http://external.example:8080';
        assert.strictEqual((await applier.applyProxyDetailed(ownedUrl, true, { silent: true })).success, true);

        const originalUnset = targets.git.unsetProxyKeys.bind(targets.git);
        targets.git.unsetProxyKeys = async (keys, options) => {
            targets.git.values['http.proxy'] = externalUrl;
            targets.git.values['https.proxy'] = externalUrl;
            return originalUnset(keys, options);
        };

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, true);
        assert.strictEqual(targets.git.values['http.proxy'], externalUrl);
        assert.strictEqual(targets.git.values['https.proxy'], externalUrl);
        assert.ok(targets.git.unsetCalls.length >= 1);
        assert.ok(targets.git.expectedValueCalls.some(expected =>
            expected?.['http.proxy'] === ownedUrl && expected?.['https.proxy'] === ownedUrl
        ));
        assert.strictEqual(result.results.gitOutcome, 'preservedExternal');
    });

    test('fails closed and does not unset when the confirming re-inspect cannot be read', async () => {
        const targets = createTargets();
        const applier = createApplier(targets, createOwnershipStore());
        await applier.applyProxyDetailed('http://owned.example:8080', true, { silent: true });

        let inspectCount = 0;
        const originalInspect = targets.git.inspectProxy.bind(targets.git);
        targets.git.inspectProxy = async () => {
            inspectCount += 1;
            if (inspectCount === 2) {
                return { status: 'error' as const, error: 'permission denied', errorType: 'NO_PERMISSION' };
            }
            return originalInspect();
        };

        const result = await applier.disableProxyDetailed({ silent: true });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.results.gitOutcome, 'failed');
        assert.deepStrictEqual(targets.git.unsetCalls, []);
        assert.strictEqual(targets.git.values['http.proxy'], 'http://owned.example:8080');
    });
});
