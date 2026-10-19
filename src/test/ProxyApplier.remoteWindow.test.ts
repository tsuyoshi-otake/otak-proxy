/**
 * @file ProxyApplier.remoteWindow.test.ts
 * @description In a remote window the applier neither writes nor removes the
 * VS Code user setting http.proxy (#108). VS Code routes a Global write from a
 * remote extension host by how http.proxy is registered in that window, so the
 * value could land in the local settings.json and be synced on; every other
 * target on the remote host is written as usual.
 *
 * Plain Node: fake writers only, no host module.
 */
import * as assert from 'assert';
import { ProxyApplier } from '../core/ProxyApplier';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';

type Constructed = ConstructorParameters<typeof ProxyApplier>;

const PROXY_URL = 'http://proxy.example.com:8080';
const REMOTE_ISSUE_ID = 'vscode.remoteExtensionHost.notWritable';

interface Recorded {
    vscode: string[];
    git: string[];
    npm: string[];
    terminal: string[];
    storeCalls: string[];
    warnings: string[];
    successes: string[];
}

function createApplier(canWriteVSCodeUserSettings: (() => boolean) | undefined, withStore = false) {
    const recorded: Recorded = { vscode: [], git: [], npm: [], terminal: [], storeCalls: [], warnings: [], successes: [] };

    const vscodeWriter = {
        setProxy: async (url: string) => { recorded.vscode.push(`set ${url}`); return { success: true }; },
        unsetProxy: async () => { recorded.vscode.push('unset'); return { success: true }; },
        inspectProxy: async () => {
            recorded.vscode.push('inspect');
            return { status: 'available' as const, values: { proxy: PROXY_URL } };
        }
    } as unknown as Constructed[1];
    const gitWriter = {
        setProxy: async (url: string) => { recorded.git.push(`set ${url}`); return { success: true }; },
        unsetProxy: async () => { recorded.git.push('unset'); return { success: true }; },
        inspectProxy: async () => ({
            status: 'available' as const,
            values: { 'http.proxy': null, 'https.proxy': null }
        }),
        unsetProxyKeys: async () => ({ success: true })
    } as unknown as Constructed[0];
    const npmWriter = {
        setProxy: async (url: string) => { recorded.npm.push(`set ${url}`); return { success: true }; },
        unsetProxy: async () => { recorded.npm.push('unset'); return { success: true }; },
        inspectOwnedProxy: async () => ({
            status: 'available' as const,
            values: { proxy: null, 'https-proxy': null }
        }),
        unsetProxyKeys: async () => ({ success: true })
    } as unknown as Constructed[2];
    const terminalWriter = {
        setProxy: async (url: string) => { recorded.terminal.push(`set ${url}`); return { success: true }; },
        unsetProxy: async () => { recorded.terminal.push('unset'); return { success: true }; }
    } as unknown as NonNullable<Constructed[7]>;
    const store = {
        remove: async (targetId: string) => { recorded.storeCalls.push(`remove ${targetId}`); },
        inspectOwnership: async (targetId: string) => {
            recorded.storeCalls.push(`inspectOwnership ${targetId}`);
            return 'owned';
        },
        bootstrapFromSnapshot: async (_url: string, snapshots: ReadonlyArray<{ targetId: string }>) => {
            recorded.storeCalls.push(`bootstrap ${snapshots.map(snapshot => snapshot.targetId).join(',')}`);
            return [];
        }
    } as unknown as Constructed[9];

    const applier = new ProxyApplier(
        gitWriter,
        vscodeWriter,
        npmWriter,
        new ProxyUrlValidator(),
        new InputSanitizer(),
        {
            showSuccess: (message: string) => { recorded.successes.push(message); },
            showError: () => {},
            showWarning: (message: string) => { recorded.warnings.push(message); }
        } as never,
        undefined,
        terminalWriter,
        undefined,
        withStore ? store : undefined,
        canWriteVSCodeUserSettings ? { canWriteVSCodeUserSettings } : undefined
    );
    return { applier, recorded };
}

const REMOTE = (): boolean => false;
const LOCAL = (): boolean => true;

suite('ProxyApplier in a remote window (#108)', () => {
    setup(() => {
        I18nManager.getInstance().initialize('en');
    });

    test('enable: the VS Code writer is never called, the other targets are written, the result is successful', async () => {
        const { applier, recorded } = createApplier(REMOTE);

        const result = await applier.applyProxyDetailed(PROXY_URL, true);

        assert.deepStrictEqual(recorded.vscode, [], 'http.proxy must not be written from a remote window');
        assert.deepStrictEqual(recorded.git, [`set ${PROXY_URL}`]);
        assert.deepStrictEqual(recorded.npm, [`set ${PROXY_URL}`]);
        assert.deepStrictEqual(recorded.terminal, [`set ${PROXY_URL}`]);
        assert.strictEqual(result.results.vscodeOutcome, 'skippedUnavailable');
        assert.strictEqual(result.results.vscodeSuccess, true, 'a skip counts as success');
        assert.strictEqual(result.success, true, 'the other targets succeeded');
        assert.deepStrictEqual(result.errors, []);
    });

    test('disable: the VS Code writer is never called, the other targets are cleared, the result is successful', async () => {
        const { applier, recorded } = createApplier(REMOTE);

        const result = await applier.disableProxyDetailed();

        assert.deepStrictEqual(recorded.vscode, [], 'http.proxy must not be removed from a remote window');
        assert.deepStrictEqual(recorded.git, ['unset']);
        assert.deepStrictEqual(recorded.npm, ['unset']);
        assert.deepStrictEqual(recorded.terminal, ['unset']);
        assert.strictEqual(result.results.vscodeOutcome, 'skippedUnavailable');
        assert.strictEqual(result.results.vscodeSuccess, true);
        assert.strictEqual(result.success, true);
    });

    test('both directions carry one advisory capability issue for the vscode target', async () => {
        for (const enabled of [true, false]) {
            const { applier } = createApplier(REMOTE);

            const result = enabled
                ? await applier.applyProxyDetailed(PROXY_URL, true)
                : await applier.disableProxyDetailed();

            const issues = (result.issues ?? []).filter(issue => issue.id === REMOTE_ISSUE_ID);
            assert.strictEqual(issues.length, 1, `${enabled ? 'enable' : 'disable'} reports the issue once`);
            const issue = issues[0];
            assert.strictEqual(issue.category, 'capabilityUnavailable');
            assert.strictEqual(issue.impact, 'advisoryResidualRisk');
            assert.strictEqual(issue.targetId, 'vscode.http.proxy');
            assert.strictEqual(issue.targetHost, 'remote');
            assert.strictEqual(issue.source, 'apply');
            assert.strictEqual(issue.capability, 'unsupported');
            assert.strictEqual(issue.autoAction, 'none');
        }
    });

    test('disable does not consult the ownership store or inspect http.proxy', async () => {
        const { applier, recorded } = createApplier(REMOTE, true);

        const result = await applier.disableProxyDetailed();

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(recorded.vscode, [], 'neither inspected nor unset');
        assert.ok(
            !recorded.storeCalls.some(call => call.includes('vscode.http.proxy')),
            `the ownership store was consulted for vscode.http.proxy: ${recorded.storeCalls.join(' | ')}`
        );
        assert.ok(recorded.storeCalls.length > 0, 'the other targets still go through the store');
    });

    test('enable records no ownership for http.proxy', async () => {
        const { applier, recorded } = createApplier(REMOTE, true);

        await applier.applyProxyDetailed(PROXY_URL, true);

        assert.ok(
            !recorded.storeCalls.some(call => call.includes('vscode.http.proxy')),
            `ownership was recorded for vscode.http.proxy: ${recorded.storeCalls.join(' | ')}`
        );
    });

    test('a visible enable shows no split warning when there is no split and no bypass', async () => {
        const { applier, recorded } = createApplier(REMOTE);

        await applier.applyProxyDetailed(PROXY_URL, true, { silent: false });

        assert.ok(!recorded.warnings.includes('warning.splitProxyPartial'), recorded.warnings.join(' | '));
        assert.strictEqual(recorded.successes.length, 1, 'the usual success message is shown');
    });

    test('control: where VS Code user settings are writable the writer is called as before', async () => {
        const { applier, recorded } = createApplier(LOCAL);

        const enabled = await applier.applyProxyDetailed(PROXY_URL, true);
        assert.deepStrictEqual(recorded.vscode, [`set ${PROXY_URL}`]);
        assert.strictEqual(enabled.results.vscodeOutcome, 'configured');
        assert.ok(!(enabled.issues ?? []).some(issue => issue.id === REMOTE_ISSUE_ID));

        const disabled = await applier.disableProxyDetailed();
        assert.deepStrictEqual(recorded.vscode, [`set ${PROXY_URL}`, 'unset']);
        assert.strictEqual(disabled.results.vscodeOutcome, 'cleared');
        assert.ok(!(disabled.issues ?? []).some(issue => issue.id === REMOTE_ISSUE_ID));
    });

    test('control: without the option the writer is called (local window behaviour is unchanged)', async () => {
        const { applier, recorded } = createApplier(undefined);

        await applier.applyProxyDetailed(PROXY_URL, true);

        assert.deepStrictEqual(recorded.vscode, [`set ${PROXY_URL}`]);
    });
});
