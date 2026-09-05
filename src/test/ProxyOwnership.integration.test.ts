import * as assert from 'assert';
import type * as vscode from 'vscode';
import { ProxyApplier } from '../core/ProxyApplier';
import { TargetOwnershipStore } from '../core/TargetOwnershipStore';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import type { GitConfigManager, GitProxyKey } from '../config/GitConfigManager';
import type { NpmConfigManager, NpmProxyKey } from '../config/NpmConfigManager';
import type { VscodeConfigManager } from '../config/VscodeConfigManager';
import type { PipConfigManager } from '../config/PipConfigManager';
import type { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import type { UserNotifier } from '../errors/UserNotifier';

interface FakeTargetSet {
    git: FakeGitManager;
    npm: FakeNpmManager;
    vscode: FakeSingleManager;
    pip: FakeSingleManager;
    terminal: FakeTerminalManager;
}

class FakeGitManager {
    values: Record<GitProxyKey, string | null> = { 'http.proxy': null, 'https.proxy': null };
    unsetCalls: GitProxyKey[][] = [];
    expectedValueCalls: Array<Partial<Record<GitProxyKey, string>> | undefined> = [];

    async setProxy(url: string) {
        this.values['http.proxy'] = url;
        this.values['https.proxy'] = url;
        return { success: true };
    }
    async unsetProxy() { return this.unsetProxyKeys(['http.proxy', 'https.proxy']); }
    async unsetProxyKeys(
        keys: readonly GitProxyKey[],
        options?: { expectedValues?: Readonly<Partial<Record<GitProxyKey, string>>> }
    ) {
        this.unsetCalls.push([...keys]);
        this.expectedValueCalls.push(options?.expectedValues ? { ...options.expectedValues } : undefined);
        const preservedKeys: GitProxyKey[] = [];
        for (const key of keys) {
            const expected = options?.expectedValues?.[key];
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
    async inspectProxy(): Promise<{
        status: 'available' | 'unavailable' | 'error';
        values?: Record<GitProxyKey, string | null>;
        error?: string;
        errorType?: string;
    }> {
        return { status: 'available', values: { ...this.values } };
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

function createOwnershipStore(): TargetOwnershipStore {
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
    return new TargetOwnershipStore(memento, new ProxyCredentialStore(secretStorage));
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

function createApplier(targets: FakeTargetSet, ownershipStore: TargetOwnershipStore): ProxyApplier {
    const notifier = {
        showSuccess: () => {},
        showWarning: () => {},
        showError: () => {}
    } as unknown as UserNotifier;
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

suite('Ownership-safe proxy disable integration', () => {
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
