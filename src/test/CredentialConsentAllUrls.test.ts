/**
 * Credential consent and policy must judge every URL a plan writes (#108).
 *
 * The reproduced leak: HTTP_PROXY without credentials plus an
 * HTTPS_PROXY with credentials builds a per-scheme state whose primary has
 * no credentials. Consent, blockPlaintextTargets and the unauthenticated
 * skip judged only that primary, while the apply re-read the state and
 * wrote the credential-bearing HTTPS URL to npm and the terminal
 * environment anyway. These tests drive the production composition —
 * runProxyApplyAttempt, the same one applyProxySafely uses — over a real
 * ProxyApplier, real ProxyStateManager and real ProxyRemediationService
 * with fake git/npm stores, so the judged set and the written set can be
 * compared.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitConfigManager } from '../config/GitConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import { splitApplyOptionsFromState } from '../config/DetectedProxyValue';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { appliedProxyInfoFromState } from '../core/AppliedProxyProvenance';
import { handleProxyStateChanged } from '../core/ExtensionProxyEventHandlers';
import { createFencedApply } from '../core/GenerationFence';
import { captureLogicalGeneration, LogicalGeneration } from '../core/LogicalGeneration';
import { ProxyApplier } from '../core/ProxyApplier';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { resolveProxyApplyOptions, proxyApplyPlanCredentialUrls, proxyApplyPlanUrls } from '../core/ProxyApplyPlan';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { SystemProxyUpdateService } from '../core/SystemProxyUpdateService';
import { publicFingerprint } from '../core/TargetOwnershipStore';
import { InitializerContext } from '../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState, stateRevision } from '../core/types';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { ProxyRemediationService, ProxyApplyTrigger } from '../remediation/ProxyRemediationService';
import { runProxyApplyAttempt } from '../remediation/ProxyApplyAttempt';
import { reapplyAfterCredentialConsent } from '../remediation/CredentialConsentReapply';
import { getStatusBarDisplay } from '../ui/StatusBarDisplay';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../sync/RemoteSyncStateApplier';
import { getCredentialKeyForPublicUrl } from '../security/ProxyCredentialStore';
import * as SystemProxyDetectionUtils from '../utils/SystemProxyDetectionUtils';
import {
    deriveAuthRequiredProxyUrls,
    getProxyPublicUrl,
    planUrlsMissingRequiredCredentials,
    removeProxyCredentials,
    sanitizeProxyStateForPersistence,
    setRequiresAuthFromLiveUrls,
    shouldSkipUnauthenticatedApply,
    UNRESOLVED_LOCAL_CREDENTIAL_ERROR
} from '../utils/ProxyStateSanitizer';
import { createFakeGitConfig, createFakeNpmConfig } from './fakeConfigStores';

// `import * as` would stub a copy of the module; the code under test calls the
// real one (the same form as ProxyConnectDirect.test.ts).
import osModule = require('os');

const HTTP_URL = 'http://proxy-http.example.com:3128';
const HTTPS_CRED_URL = 'http://user:secret@proxy-https.example.com:3128';
const OTHER_CRED_URL = 'http://other:pw@other.example.com:9999';
// The brief's own reproduction: ONE proxy for both schemes, credentials on
// HTTPS only (HTTP_PROXY=http://proxy:3128, HTTPS_PROXY=http://user:secret@proxy:3128).
const SAME_HOST_URL = 'http://proxy.example.com:3128';
const SAME_HOST_CRED_URL = 'http://user:secret@proxy.example.com:3128';
// Two different proxy addresses, both credential-bearing (finding 2).
const PROXY_A_CRED_URL = 'http://u1:p1@proxy-a.example.com:3128';
const PROXY_B_CRED_URL = 'http://u2:p2@proxy-b.example.com:3128';
const PROXY_A_PLAIN_URL = 'http://proxy-a.example.com:3128';
const CONSENT_KEY = 'otakProxy.v3.credentialTargetConsent';

// The key format earlier versions stored, so the test also checks that
// consent recorded before this change still matches.
function consentKeyFor(url: string): string {
    return publicFingerprint(removeProxyCredentials(url) || url);
}

function fakeExtensionContext(globalState: Map<string, unknown>, secrets: Map<string, string>) {
    return {
        globalState: {
            get: (key: string, defaultValue?: unknown) =>
                globalState.has(key) ? globalState.get(key) : defaultValue,
            update: async (key: string, value: unknown) => { globalState.set(key, value); },
            keys: () => [...globalState.keys()],
            setKeysForSync: () => {}
        },
        workspaceState: {} as vscode.Memento,
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        },
        subscriptions: []
    } as unknown as vscode.ExtensionContext;
}

/** The background-4 reproduction: split per-scheme state whose primary carries no credentials. */
function splitState(overrides: Partial<ProxyState> = {}): ProxyState {
    return {
        mode: ProxyMode.Auto,
        revision: 1,
        autoProxyUrl: HTTP_URL,
        autoProxyKind: 'perSchemeProxy',
        autoHttpProxyUrl: HTTP_URL,
        autoHttpsProxyUrl: HTTPS_CRED_URL,
        lastDetectionSource: 'environment',
        ...overrides
    };
}

/** One proxy for both schemes; only the HTTPS URL carries credentials. */
function sameHostSplitState(): ProxyState {
    return splitState({
        autoProxyUrl: SAME_HOST_URL,
        autoHttpProxyUrl: SAME_HOST_URL,
        autoHttpsProxyUrl: SAME_HOST_CRED_URL
    });
}

interface Harness {
    globalState: Map<string, unknown>;
    secrets: Map<string, string>;
    stateManager: ProxyStateManager;
    applier: ProxyApplier;
    service: ProxyRemediationService;
    git: ReturnType<typeof createFakeGitConfig>;
    npm: ReturnType<typeof createFakeNpmConfig>;
    envVars: Map<string, string>;
    vscodeSetCalls: string[];
    applySafely(
        url: string,
        enabled: boolean,
        trigger: ProxyApplyTrigger,
        options?: ProxyApplyOptions
    ): Promise<{ success: boolean; applyResult?: ProxyApplyDetailedResult; stopReason?: string }>;
}

function createHarness(globalState: Map<string, unknown> = new Map<string, unknown>()): Harness {
    const secrets = new Map<string, string>();
    const context = fakeExtensionContext(globalState, secrets);
    const stateManager = new ProxyStateManager(context);

    const git = createFakeGitConfig();
    const npm = createFakeNpmConfig();
    const envVars = new Map<string, string>();
    const vscodeSetCalls: string[] = [];

    const terminalEnvManager = new TerminalEnvConfigManager({
        replace: (name: string, value: string) => { envVars.set(name, value); },
        delete: (name: string) => { envVars.delete(name); }
    });

    const applier = new ProxyApplier(
        new GitConfigManager({ commandRunner: git.runner }),
        {
            setProxy: async (url: string) => {
                vscodeSetCalls.push(url);
                return { success: true };
            },
            unsetProxy: async () => ({ success: true })
        } as never,
        new NpmConfigManager(undefined, {
            commandRunner: npm.runner,
            commandAvailable: () => true,
            readUserConfigFile: npm.readUserConfigFile
        }),
        new ProxyUrlValidator(),
        new InputSanitizer(),
        {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as never,
        stateManager,
        terminalEnvManager
    );

    const service = new ProxyRemediationService(
        context,
        () => stateManager.getState(),
        {
            diagnostics: { run: async () => undefined } as unknown as ProxyRuntimeDiagnostics
        }
    );

    // The production composition applyProxySafely delegates to: one state
    // read, one resolved plan, the fenced apply and the remediation service.
    const applySafely: Harness['applySafely'] = (url, enabled, trigger, options) =>
        runProxyApplyAttempt(
            stateManager,
            (proxyUrl, shouldEnable, applyOptions, basis) =>
                applier.applyProxyDetailed(proxyUrl, shouldEnable, applyOptions, basis),
            service,
            url,
            enabled,
            trigger,
            options
        );

    return { globalState, secrets, stateManager, applier, service, git, npm, envVars, vscodeSetCalls, applySafely };
}

function assertNothingWritten(harness: Harness): void {
    assert.strictEqual(harness.npm.get('proxy'), null, 'npm proxy must not be written');
    assert.strictEqual(harness.npm.get('https-proxy'), null, 'npm https-proxy must not be written');
    assert.strictEqual(harness.git.get('http.proxy'), null, 'git http.proxy must not be written');
    assert.deepStrictEqual(harness.vscodeSetCalls, [], 'vscode http.proxy must not be written');
    assert.strictEqual(harness.envVars.size, 0, 'terminal environment must not be written');
}

/** Wires the re-apply the way extension.ts does, over the harness's own apply. */
function wireConsentReapply(harness: Harness): void {
    harness.service.setCredentialConsentReapply(() => reapplyAfterCredentialConsent({
        getState: () => harness.stateManager.getState(),
        getActiveProxyUrl: state => harness.stateManager.getActiveProxyUrl(state),
        applyProxySafely: async (url, enabled, trigger) => (await harness.applySafely(url, enabled, trigger)).success,
        updateStatusBar: () => {}
    }));
}

/** Resolves once the condition holds; the prompt answer and the re-apply run detached. */
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            assert.fail(`timed out waiting for ${what}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/** Fails instead of hanging when the attempt does not settle within the bound. */
async function settlesWithin<T>(attempt: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([attempt, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

suite('Credential consent judges every URL in the plan (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let showWarning: sinon.SinonStub;
    let otakConfig: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = {
            notificationLevel: 'off',
            hostUserLockEnabled: false,
            diagnosticsEnabled: false
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('a split plan asks consent before any write and writes nothing on deny', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState(splitState());

        const result = await harness.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, false);
        assert.strictEqual(showWarning.callCount, 1, 'the consent prompt must be shown once');
        assertNothingWritten(harness);
        assert.strictEqual(result.stopReason, 'consentRequired');
    });

    test('blockPlaintextTargets blocks a split plan whose HTTPS URL carries credentials', async () => {
        otakConfig.credentialTargetPolicy = 'blockPlaintextTargets';
        const harness = createHarness();
        await harness.stateManager.saveState(splitState());

        const result = await harness.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stopReason, 'consentRequired');
        assertNothingWritten(harness);
    });

    test('a silent split apply without consent is skipped and writes nothing', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState(splitState());

        const result = await harness.applySafely(HTTP_URL, true, 'autoReachability', { silent: true });

        assert.strictEqual(result.success, false);
        assert.strictEqual(showWarning.callCount, 0, 'a silent apply must not prompt');
        assertNothingWritten(harness);
    });

    test('consent for the credential-bearing public URL lets the split write proceed', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState(splitState());
        harness.globalState.set(CONSENT_KEY, { [consentKeyFor(HTTPS_CRED_URL)]: true });

        const result = await harness.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
        assert.strictEqual(harness.npm.get('proxy'), HTTP_URL);
        assert.strictEqual(harness.npm.get('https-proxy'), HTTPS_CRED_URL);
        assert.strictEqual(harness.envVars.get('HTTPS_PROXY'), HTTPS_CRED_URL);
    });

    suite('the prompt is answered after the apply has returned', () => {
        let answer: (choice: string | undefined) => void;
        let allowLabel: string;

        setup(() => {
            allowLabel = I18nManager.getInstance().t('action.allowPlaintextWrite');
            showWarning.callsFake(() => new Promise(resolve => { answer = resolve as typeof answer; }));
        });

        test('a second attempt settles while the first prompt is still open, and shows no second prompt', async () => {
            const harness = createHarness();
            await harness.stateManager.saveState(splitState());

            const first = await settlesWithin(harness.applySafely(HTTP_URL, true, 'autoDetection'), 500, 'the first attempt');
            const second = await settlesWithin(harness.applySafely(HTTP_URL, true, 'autoDetection'), 500, 'the second attempt');

            assert.strictEqual(first.stopReason, 'consentRequired');
            assert.strictEqual(second.stopReason, 'consentRequired');
            assert.strictEqual(showWarning.callCount, 1, 'one prompt per consent-key set while it is open');
            assertNothingWritten(harness);
            answer(undefined);
        });

        test('a startup apply returns without waiting for the prompt', async () => {
            const harness = createHarness();
            await harness.stateManager.saveState(splitState());

            const result = await settlesWithin(harness.applySafely(HTTP_URL, true, 'startup'), 500, 'the startup apply');

            assert.strictEqual(result.success, false);
            assert.strictEqual(showWarning.callCount, 1);
            answer(undefined);
        });

        test('the blocked marker is committed before the prompt is shown', async () => {
            const harness = createHarness();
            await harness.stateManager.saveState(splitState());
            let markerWhenShown: ProxyState['applyBlocked'] | 'not shown';
            markerWhenShown = 'not shown';
            showWarning.callsFake(() => {
                void harness.stateManager.getState().then(state => { markerWhenShown = state.applyBlocked; });
                return new Promise(resolve => { answer = resolve as typeof answer; });
            });

            await harness.applySafely(HTTP_URL, true, 'autoDetection');
            await until(() => markerWhenShown !== 'not shown', 'the prompt');

            assert.strictEqual(markerWhenShown, 'credentialConsent');
            answer(undefined);
        });

        test('Allow records consent and one re-apply writes the plan and clears the marker', async () => {
            const harness = createHarness();
            wireConsentReapply(harness);
            await harness.stateManager.saveState(splitState());

            const first = await harness.applySafely(HTTP_URL, true, 'autoDetection');
            assert.strictEqual(first.success, false);
            answer(allowLabel);

            await until(() => harness.npm.get('https-proxy') === HTTPS_CRED_URL, 'the re-apply to write npm');
            assert.strictEqual(harness.envVars.get('HTTPS_PROXY'), HTTPS_CRED_URL);
            assert.deepStrictEqual(harness.globalState.get(CONSENT_KEY), { [consentKeyFor(HTTPS_CRED_URL)]: true });
            await until(async () => (await harness.stateManager.getState()).applyBlocked === undefined, 'the marker to clear');
            assert.strictEqual(showWarning.callCount, 1, 'no second prompt for the re-apply');
        });

        test('Deny records nothing, keeps the marker and shows Auto (blocked)', async () => {
            const harness = createHarness();
            wireConsentReapply(harness);
            await harness.stateManager.saveState(splitState());

            await harness.applySafely(HTTP_URL, true, 'autoDetection');
            answer(undefined);
            await new Promise(resolve => setTimeout(resolve, 50));

            const state = await harness.stateManager.getState();
            assert.strictEqual(state.applyBlocked, 'credentialConsent');
            assert.strictEqual(harness.globalState.get(CONSENT_KEY), undefined);
            assertNothingWritten(harness);
            const display = getStatusBarDisplay(state, true, I18nManager.getInstance(), new InputSanitizer());
            assert.strictEqual(display.text, `$(warning) ${I18nManager.getInstance().t('statusbar.autoApplyBlocked')}`);
        });

        test('Off while the prompt is open clears the marker, and a later Allow applies nothing', async () => {
            const harness = createHarness();
            wireConsentReapply(harness);
            await harness.stateManager.saveState(splitState());
            await harness.applySafely(HTTP_URL, true, 'autoDetection');

            await harness.stateManager.saveState({ ...(await harness.stateManager.getState()), mode: ProxyMode.Off });
            await harness.applySafely('', false, 'manual');
            assert.strictEqual((await harness.stateManager.getState()).applyBlocked, undefined);

            answer(allowLabel);
            await until(() => harness.globalState.get(CONSENT_KEY) !== undefined, 'consent to be recorded');
            await new Promise(resolve => setTimeout(resolve, 50));

            assertNothingWritten(harness);
            assert.strictEqual((await harness.stateManager.getState()).mode, ProxyMode.Off);
        });

        test('a failing consent write is logged, nothing is re-applied and nothing throws', async () => {
            const harness = createHarness();
            wireConsentReapply(harness);
            await harness.stateManager.saveState(splitState());
            sandbox.stub(harness.service as unknown as { context: vscode.ExtensionContext }, 'context').value({
                globalState: {
                    get: () => ({}),
                    update: async () => { throw new Error('disk full'); }
                }
            });

            await harness.applySafely(HTTP_URL, true, 'autoDetection');
            answer(allowLabel);
            await new Promise(resolve => setTimeout(resolve, 50));

            assertNothingWritten(harness);
        });

        test('a split with two credentialed addresses asks once for both, and a third address asks again', async () => {
            const harness = createHarness();
            wireConsentReapply(harness);
            await harness.stateManager.saveState(twoAddressCredSplitState());

            await harness.applySafely(PROXY_A_CRED_URL, true, 'autoDetection');
            answer(allowLabel);
            await until(() => harness.npm.get('https-proxy') === PROXY_B_CRED_URL, 'the re-apply to write npm');
            assert.deepStrictEqual(
                Object.keys(harness.globalState.get(CONSENT_KEY) as Record<string, boolean>).sort(),
                [consentKeyFor(PROXY_A_CRED_URL), consentKeyFor(PROXY_B_CRED_URL)].sort()
            );
            assert.strictEqual(showWarning.callCount, 1);

            const again = await harness.applySafely(PROXY_A_CRED_URL, true, 'autoDetection');
            assert.strictEqual(again.success, true, 'both addresses were consented to together');
            assert.strictEqual(showWarning.callCount, 1, 'no re-prompt');

            await harness.stateManager.saveState(twoAddressCredSplitState({ autoHttpsProxyUrl: OTHER_CRED_URL }));
            const third = await harness.applySafely(PROXY_A_CRED_URL, true, 'autoDetection');
            assert.strictEqual(third.stopReason, 'consentRequired');
            assert.strictEqual(showWarning.callCount, 2, 'a new credentialed address needs its own consent');
            answer(undefined);
        });
    });

    test('same-host split: the detection apply prompts before any write and denies write nothing', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState(sameHostSplitState());
        // The apply detection makes: the explicit split options
        // splitApplyOptionsFromState builds over a credential-free primary,
        // computed from the raw detected fields — the hydrated state pulls
        // the credentials into every field that shares the public URL.
        const options = splitApplyOptionsFromState(sameHostSplitState());
        showWarning.callsFake(async () => {
            assertNothingWritten(harness);
            return undefined;
        });

        const result = await harness.applySafely(SAME_HOST_URL, true, 'autoDetection', options);

        assert.strictEqual(result.success, false);
        assert.strictEqual(showWarning.callCount, 1, 'the consent prompt must be shown once, before any write');
        assert.strictEqual(result.stopReason, 'consentRequired');
        assertNothingWritten(harness);
    });

    test('same-host split: blockPlaintextTargets blocks the detection apply', async () => {
        otakConfig.credentialTargetPolicy = 'blockPlaintextTargets';
        const harness = createHarness();
        await harness.stateManager.saveState(sameHostSplitState());
        const options = splitApplyOptionsFromState(sameHostSplitState());

        const result = await harness.applySafely(SAME_HOST_URL, true, 'autoDetection', options);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stopReason, 'consentRequired');
        assertNothingWritten(harness);
    });
});

/**
 * The consent record lives in the globalState that a local window and every
 * remote window of one profile share, so a key carries the host scope: a remote
 * host is asked once for itself, and consent recorded before the scope existed
 * keeps covering the local window (#108). The service reads the scope when it
 * is constructed, so the identity is set before createHarness.
 */
suite('Credential consent is per host (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let showWarning: sinon.SinonStub;
    let remoteName: sinon.SinonStub;
    let hostname: sinon.SinonStub;
    let homedir: sinon.SinonStub;
    let savedDistro: string | undefined;
    let answer: (choice: string | undefined) => void;

    function connectTo(host: { remote?: string; hostname?: string; homedir?: string; distro?: string }): void {
        remoteName.value(host.remote);
        hostname.returns(host.hostname ?? 'unused-host');
        homedir.returns(host.homedir ?? '/home/unused');
        if (host.distro === undefined) {
            delete process.env.WSL_DISTRO_NAME;
        } else {
            process.env.WSL_DISTRO_NAME = host.distro;
        }
    }

    setup(() => {
        I18nManager.getInstance().initialize('en');
        savedDistro = process.env.WSL_DISTRO_NAME;
        sandbox = sinon.createSandbox();
        remoteName = sandbox.stub(vscode.env, 'remoteName').value(undefined);
        hostname = sandbox.stub(osModule, 'hostname').returns('unused-host');
        homedir = sandbox.stub(osModule, 'homedir').returns('/home/unused');
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && ['notificationLevel', 'hostUserLockEnabled', 'diagnosticsEnabled'].includes(key)
                    ? (key === 'notificationLevel' ? 'off' : false)
                    : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        showWarning = sandbox.stub(vscode.window, 'showWarningMessage').callsFake(
            () => new Promise(resolve => { answer = resolve as typeof answer; })
        );
    });

    teardown(() => {
        sandbox.restore();
        if (savedDistro === undefined) {
            delete process.env.WSL_DISTRO_NAME;
        } else {
            process.env.WSL_DISTRO_NAME = savedDistro;
        }
    });

    async function planned(harness: Harness): Promise<void> {
        await harness.stateManager.saveState(splitState());
    }

    test('consent stored under today\'s key still covers the local window', async () => {
        const shared = new Map<string, unknown>([[CONSENT_KEY, { [consentKeyFor(HTTPS_CRED_URL)]: true }]]);
        connectTo({});
        const local = createHarness(shared);
        await planned(local);

        const result = await local.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
        assert.strictEqual(showWarning.callCount, 0, 'no prompt: the old key is honored locally');
    });

    test('an Allow recorded in the local scope does not cover a remote scope', async () => {
        const shared = new Map<string, unknown>([[CONSENT_KEY, { [consentKeyFor(HTTPS_CRED_URL)]: true }]]);
        connectTo({ remote: 'ssh-remote', hostname: 'host-a', homedir: '/home/a' });
        const remote = createHarness(shared);
        await planned(remote);

        const result = await remote.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stopReason, 'consentRequired', 'the remote host is asked for itself');
        assert.strictEqual(showWarning.callCount, 1);
        assertNothingWritten(remote);
        answer(undefined);
    });

    test('an Allow in one remote scope covers that scope and no other', async () => {
        const shared = new Map<string, unknown>();
        const allowLabel = I18nManager.getInstance().t('action.allowPlaintextWrite');

        connectTo({ remote: 'ssh-remote', hostname: 'host-a', homedir: '/home/a' });
        const hostA = createHarness(shared);
        wireConsentReapply(hostA);
        await planned(hostA);
        const first = await hostA.applySafely(HTTP_URL, true, 'autoDetection');
        assert.strictEqual(first.stopReason, 'consentRequired');
        answer(allowLabel);
        await until(() => hostA.npm.get('https-proxy') === HTTPS_CRED_URL, 'the Allow to re-apply on host A');
        assert.strictEqual(showWarning.callCount, 1);

        // The same remote host again: the recorded consent covers it.
        const hostAAgain = createHarness(shared);
        await planned(hostAAgain);
        const again = await hostAAgain.applySafely(HTTP_URL, true, 'autoDetection');
        assert.strictEqual(again.success, true, JSON.stringify(again.applyResult?.errors));
        assert.strictEqual(showWarning.callCount, 1, 'no second prompt on the same host');

        // Another host of the same kind, another home directory, another WSL
        // distribution, and the local window: each is asked for itself.
        const others: Array<[string, Parameters<typeof connectTo>[0]]> = [
            ['another host name', { remote: 'ssh-remote', hostname: 'host-b', homedir: '/home/a' }],
            ['another home directory', { remote: 'ssh-remote', hostname: 'host-a', homedir: '/home/b' }],
            ['another WSL distribution', { remote: 'ssh-remote', hostname: 'host-a', homedir: '/home/a', distro: 'Debian' }],
            ['another remote kind', { remote: 'wsl', hostname: 'host-a', homedir: '/home/a' }],
            ['the local window', {}]
        ];
        for (const [label, host] of others) {
            connectTo(host);
            const other = createHarness(shared);
            await planned(other);
            const prompts: number = showWarning.callCount;

            const result = await other.applySafely(HTTP_URL, true, 'autoDetection');

            assert.strictEqual(result.stopReason, 'consentRequired', `${label} must be asked for itself`);
            assert.strictEqual(showWarning.callCount, prompts + 1, label);
            assertNothingWritten(other);
            answer(undefined);
        }
    });
});

suite('Split credentials survive a reload (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let otakConfig: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = {
            notificationLevel: 'off',
            hostUserLockEnabled: false,
            diagnosticsEnabled: false
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('same machine: credentials are restored, the startup apply writes them, re-detection does not re-apply', async () => {
        const globalState = new Map<string, unknown>();
        const secrets = new Map<string, string>();
        const firstContext = fakeExtensionContext(globalState, secrets);
        await new ProxyStateManager(firstContext).saveState(splitState());

        const persisted = globalState.get('proxyState') as ProxyState;
        assert.ok(!JSON.stringify(persisted).includes('secret'), 'persisted state must not carry the password');

        // A new window on the same machine: fresh manager, same globalState
        // and the same SecretStorage contents.
        const harness = createHarness();
        for (const [key, value] of globalState) {
            harness.globalState.set(key, value);
        }
        for (const [key, value] of secrets) {
            harness.secrets.set(key, value);
        }
        const reloaded = await harness.stateManager.getState();
        assert.strictEqual(reloaded.autoHttpsProxyUrl, HTTPS_CRED_URL, 'split credentials must be restored');
        assert.strictEqual(reloaded.autoHttpProxyUrl, HTTP_URL);

        harness.globalState.set(CONSENT_KEY, { [consentKeyFor(HTTPS_CRED_URL)]: true });
        const result = await harness.applySafely(reloaded.autoProxyUrl!, true, 'startup');

        assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
        assert.strictEqual(result.applyResult?.errors.length, 0, 'no invalidProxyUrl or other write error');
        assert.strictEqual(harness.npm.get('https-proxy'), HTTPS_CRED_URL);

        // Re-detecting the same environment must find no change.
        const detection = {
            proxyUrl: HTTP_URL,
            source: 'environment' as const,
            kind: 'perSchemeProxy' as const,
            httpUrl: HTTP_URL,
            httpsUrl: HTTPS_CRED_URL,
            capability: 'supported' as const
        };
        sandbox.stub(SystemProxyDetectionUtils, 'detectSystemProxySettingsWithSource').resolves(detection);
        const applySpy = sandbox.spy();
        const updateService = new SystemProxyUpdateService(
            {
                extensionContext: {} as never,
                proxyStateManager: harness.stateManager,
                proxyApplier: {} as never,
                applyProxySettings: async () => {
                    applySpy();
                    return true;
                },
                systemProxyDetector: {} as never,
                userNotifier: { showSuccess: () => {}, showWarning: () => {} } as never,
                sanitizer: new InputSanitizer(),
                proxyChangeLogger: {} as never,
                publishProxyState: async () => {}
            } as unknown as InitializerContext,
            () => null
        );

        await updateService.checkAndUpdateSystemProxy();

        assert.strictEqual(applySpy.callCount, 0, 'an unchanged re-detection must not trigger another apply');
    });

    test('another machine: unresolved split credentials skip the startup apply and the sync apply', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets)).saveState(splitState());
        const persisted = originState.get('proxyState') as ProxyState;

        // A different machine: the same persisted state, empty SecretStorage.
        const harness = createHarness();
        for (const [key, value] of originState) {
            harness.globalState.set(key, value);
        }
        const reloaded = await harness.stateManager.getState();
        assert.strictEqual(reloaded.requiresAuth, true);
        assert.ok(!reloaded.autoHttpsProxyUrl || !reloaded.autoHttpsProxyUrl.includes('secret'));

        const activeUrl = reloaded.autoProxyUrl || '';
        const planOptions = resolveProxyApplyOptions(activeUrl, undefined, reloaded);
        assert.strictEqual(
            shouldSkipUnauthenticatedApply(reloaded, proxyApplyPlanUrls(activeUrl, planOptions)),
            true,
            'the startup apply must skip when no plan URL carries credentials'
        );

        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const syncContext: RemoteSyncApplyContext = {
            saveState: async next => { await harness.stateManager.saveState(next); },
            getState: () => harness.stateManager.getState(),
            commitState: (expected, next) => harness.stateManager.commitState(expected, next),
            getActiveProxyUrl: state => harness.stateManager.getActiveProxyUrl(state),
            applyProxy: async (url, enabled) => {
                applyCalls.push({ url, enabled });
                return true;
            },
            startMonitoring: async () => {},
            stopMonitoring: async () => {},
            updateStatus: () => {}
        };

        const applied = await applyRemoteSyncState({ ...persisted }, syncContext);

        assert.strictEqual(applied, false);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual((await harness.stateManager.getState()).lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR);
        assertNothingWritten(harness);
    });

    test('same-host split: after a reload every written URL is one consent judged', async () => {
        const reload = async () => {
            const originState = new Map<string, unknown>();
            const originSecrets = new Map<string, string>();
            await new ProxyStateManager(fakeExtensionContext(originState, originSecrets)).saveState(sameHostSplitState());
            const harness = createHarness();
            for (const [key, value] of originState) {
                harness.globalState.set(key, value);
            }
            for (const [key, value] of originSecrets) {
                harness.secrets.set(key, value);
            }
            const reloaded = await harness.stateManager.getState();
            return { harness, reloaded };
        };

        // The secret store is keyed by the public URL, so all three fields
        // hydrate to the single credential-bearing URL.
        {
            const { reloaded } = await reload();
            assert.strictEqual(reloaded.autoProxyUrl, SAME_HOST_CRED_URL);
            assert.strictEqual(reloaded.autoHttpProxyUrl, SAME_HOST_CRED_URL);
            assert.strictEqual(reloaded.autoHttpsProxyUrl, SAME_HOST_CRED_URL);
        }

        // A silent startup-style apply without consent writes nothing.
        {
            const { harness, reloaded } = await reload();
            const result = await harness.applySafely(reloaded.autoProxyUrl!, true, 'startup', { silent: true });
            assert.strictEqual(result.success, false);
            assertNothingWritten(harness);
        }

        // blockPlaintextTargets writes nothing either.
        {
            otakConfig.credentialTargetPolicy = 'blockPlaintextTargets';
            try {
                const { harness, reloaded } = await reload();
                const result = await harness.applySafely(reloaded.autoProxyUrl!, true, 'startup');
                assert.strictEqual(result.success, false);
                assert.strictEqual(result.stopReason, 'consentRequired');
                assertNothingWritten(harness);
            } finally {
                delete otakConfig.credentialTargetPolicy;
            }
        }

        // With consent every value written to npm and the terminal
        // environment is a URL consent judged.
        {
            const { harness, reloaded } = await reload();
            harness.globalState.set(CONSENT_KEY, { [consentKeyFor(SAME_HOST_CRED_URL)]: true });
            const plan = resolveProxyApplyOptions(reloaded.autoProxyUrl!, undefined, reloaded);
            const judged = new Set(proxyApplyPlanCredentialUrls(reloaded.autoProxyUrl!, plan));

            const result = await harness.applySafely(reloaded.autoProxyUrl!, true, 'startup');

            assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
            const written = [
                harness.npm.get('proxy'),
                harness.npm.get('https-proxy'),
                harness.envVars.get('HTTP_PROXY'),
                harness.envVars.get('HTTPS_PROXY')
            ].filter((value): value is string => Boolean(value));
            assert.ok(written.length > 0, 'the apply must have written at least one URL');
            for (const value of written) {
                assert.ok(judged.has(value), `written URL was not judged by consent: ${value}`);
            }
        }
    });
});

// Credentials on two different proxy addresses (finding 2, #108).
function twoAddressCredSplitState(overrides: Partial<ProxyState> = {}): ProxyState {
    return {
        mode: ProxyMode.Auto,
        revision: 1,
        autoProxyUrl: PROXY_A_CRED_URL,
        autoProxyKind: 'perSchemeProxy',
        autoHttpProxyUrl: PROXY_A_CRED_URL,
        autoHttpsProxyUrl: PROXY_B_CRED_URL,
        lastDetectionSource: 'environment',
        ...overrides
    };
}

function proxyAPublicUrl(): string {
    return getProxyPublicUrl(PROXY_A_CRED_URL)!;
}

function proxyBPublicUrl(): string {
    return getProxyPublicUrl(PROXY_B_CRED_URL)!;
}

function remoteSyncContext(harness: Harness, applyCalls: Array<{ url: string; enabled: boolean }>): RemoteSyncApplyContext {
    return {
        saveState: async next => { await harness.stateManager.saveState(next); },
        getState: () => harness.stateManager.getState(),
        commitState: (expected, next) => harness.stateManager.commitState(expected, next),
        getActiveProxyUrl: state => harness.stateManager.getActiveProxyUrl(state),
        applyProxy: async (url, enabled) => {
            applyCalls.push({ url, enabled });
            return true;
        },
        startMonitoring: async () => {},
        stopMonitoring: async () => {},
        updateStatus: () => {}
    };
}

function reloadHarness(globalState: Map<string, unknown>, secrets?: Map<string, string>): Harness {
    const harness = createHarness();
    for (const [key, value] of globalState) {
        harness.globalState.set(key, value);
    }
    for (const [key, value] of secrets ?? []) {
        harness.secrets.set(key, value);
    }
    return harness;
}

suite('Echo identity survives a reload (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let otakConfig: Record<string, unknown>;
    let httpProxyValue: string | undefined;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = { notificationLevel: 'off', diagnosticsEnabled: false };
        httpProxyValue = undefined;
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => {
            if (section === 'http') {
                return {
                    get: (key: string) => (key === 'proxy' ? httpProxyValue : undefined),
                    has: () => true,
                    inspect: () => undefined,
                    update: async () => {}
                };
            }
            return {
                get: (key: string, defaultValue?: unknown) =>
                    section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
                update: async () => {},
                has: () => true,
                inspect: () => undefined
            };
        }) as typeof vscode.workspace.getConfiguration);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    // A reloaded (persisted + hydrated) applied URL spells the same proxy
    // differently from the value VS Code still holds: host is lower-cased and
    // a default port is dropped. Echo suppression must still recognize it.
    for (const original of ['http://user:pass@PROXY.EXAMPLE.COM:80', 'https://user:pass@PROXY.EXAMPLE.COM:443']) {
        test(`a re-spelled credential-bearing applied URL is still the echo (${original})`, async () => {
            const globalState = new Map<string, unknown>();
            const secrets = new Map<string, string>();
            await new ProxyStateManager(fakeExtensionContext(globalState, secrets)).saveState({
                mode: ProxyMode.Auto,
                autoProxyUrl: original,
                lastDetectionSource: 'environment'
            });

            const harness = reloadHarness(globalState, secrets);
            const applied = appliedProxyInfoFromState(await harness.stateManager.getState());
            assert.ok(applied, 'provider must report an applied proxy');
            assert.notStrictEqual(
                applied.url,
                original,
                'premise: hydration must re-spell the URL (host case, default port)'
            );
            assert.ok(applied.url.includes('user:pass'), 'credentials must be restored');

            httpProxyValue = original;
            const detector = new SystemProxyDetector(['vscode']);
            detector.setAppliedProxyProvider(async () => applied);

            const result = await detector.detectSystemProxyWithSource();

            assert.strictEqual(result.proxyUrl, null, 'the re-spelled own write must be suppressed');
            assert.strictEqual(result.source, null);
        });
    }
});

suite('Per-address credential requirement (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let otakConfig: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = {
            notificationLevel: 'off',
            hostUserLockEnabled: false,
            diagnosticsEnabled: false
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('only one of two credentialed addresses restored: the startup gate and the sync apply both skip', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(twoAddressCredSplitState());
        const persisted = originState.get('proxyState') as ProxyState;
        assert.deepStrictEqual(
            persisted.authRequiredProxyUrls,
            [proxyAPublicUrl(), proxyBPublicUrl()],
            'the persisted state must record both credential-bearing addresses'
        );

        // A machine whose SecretStorage holds only proxy-a's secret.
        const harness = reloadHarness(originState, new Map(
            [...originSecrets].filter(([key]) => key !== getCredentialKeyForPublicUrl(proxyBPublicUrl()))
        ));
        const reloaded = await harness.stateManager.getState();
        assert.strictEqual(reloaded.autoHttpProxyUrl, PROXY_A_CRED_URL, 'proxy-a credentials must be restored');
        assert.ok(
            reloaded.autoHttpsProxyUrl && !reloaded.autoHttpsProxyUrl.includes('u2'),
            'premise: proxy-b must hydrate without credentials'
        );
        assert.strictEqual(reloaded.requiresAuth, true);

        const activeUrl = reloaded.autoProxyUrl || '';
        const planOptions = resolveProxyApplyOptions(activeUrl, undefined, reloaded);
        assert.strictEqual(
            shouldSkipUnauthenticatedApply(reloaded, proxyApplyPlanUrls(activeUrl, planOptions)),
            true,
            'the apply must skip: proxy-b would be written without its credentials'
        );

        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const applied = await applyRemoteSyncState({ ...persisted }, remoteSyncContext(harness, applyCalls));

        assert.strictEqual(applied, false);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual((await harness.stateManager.getState()).lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR);
        assertNothingWritten(harness);
    });

    test('a SecretStorage write that failed for one split address: the startup gate and the sync apply both skip', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        const originContext = fakeExtensionContext(originState, originSecrets);
        const proxyBKey = getCredentialKeyForPublicUrl(proxyBPublicUrl());
        originContext.secrets.store = async (key: string, value: string) => {
            if (key === proxyBKey) {
                throw new Error('SecretStorage write failed');
            }
            originSecrets.set(key, value);
        };
        await new ProxyStateManager(originContext).saveState(twoAddressCredSplitState());
        const persisted = originState.get('proxyState') as ProxyState;
        assert.deepStrictEqual(
            persisted.authRequiredProxyUrls,
            [proxyAPublicUrl(), proxyBPublicUrl()],
            'the persisted state must record both credential-bearing addresses even when one secret write failed'
        );
        assert.ok(originSecrets.has(getCredentialKeyForPublicUrl(proxyAPublicUrl())), 'proxy-a secret must be stored');
        assert.ok(!originSecrets.has(proxyBKey), 'premise: proxy-b secret must be missing');

        const harness = reloadHarness(originState, originSecrets);
        const reloaded = await harness.stateManager.getState();
        assert.strictEqual(reloaded.autoHttpProxyUrl, PROXY_A_CRED_URL);
        assert.ok(reloaded.autoHttpsProxyUrl && !reloaded.autoHttpsProxyUrl.includes('u2'));

        const activeUrl = reloaded.autoProxyUrl || '';
        const planOptions = resolveProxyApplyOptions(activeUrl, undefined, reloaded);
        assert.strictEqual(
            shouldSkipUnauthenticatedApply(reloaded, proxyApplyPlanUrls(activeUrl, planOptions)),
            true,
            'the apply must skip: proxy-b was recorded as credential-bearing but cannot hydrate'
        );

        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const applied = await applyRemoteSyncState({ ...persisted }, remoteSyncContext(harness, applyCalls));

        assert.strictEqual(applied, false);
        assert.deepStrictEqual(applyCalls, []);
        assert.strictEqual((await harness.stateManager.getState()).lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR);
        assertNothingWritten(harness);
    });

    test('an address that never carried credentials does not trip the gate', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(twoAddressCredSplitState({
                autoProxyUrl: PROXY_A_PLAIN_URL,
                autoHttpProxyUrl: PROXY_A_PLAIN_URL
            }));
        const persisted = originState.get('proxyState') as ProxyState;
        assert.deepStrictEqual(
            persisted.authRequiredProxyUrls,
            [proxyBPublicUrl()],
            'only the credentialed address is recorded'
        );

        // With proxy-b's secret the gate does not skip and the apply writes
        // proxy-b with its credentials; proxy-a is written credential-free.
        {
            const harness = reloadHarness(originState, originSecrets);
            const reloaded = await harness.stateManager.getState();
            assert.strictEqual(reloaded.autoHttpsProxyUrl, PROXY_B_CRED_URL, 'proxy-b credentials must be restored');
            assert.strictEqual(reloaded.autoHttpProxyUrl, PROXY_A_PLAIN_URL);

            const activeUrl = reloaded.autoProxyUrl || '';
            const planOptions = resolveProxyApplyOptions(activeUrl, undefined, reloaded);
            assert.strictEqual(
                shouldSkipUnauthenticatedApply(reloaded, proxyApplyPlanUrls(activeUrl, planOptions)),
                false,
                'a credential-free address that never needed credentials must not trip the gate'
            );

            harness.globalState.set(CONSENT_KEY, { [consentKeyFor(PROXY_B_CRED_URL)]: true });
            const result = await harness.applySafely(activeUrl, true, 'startup');
            assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
            assert.strictEqual(harness.npm.get('https-proxy'), PROXY_B_CRED_URL);
            assert.strictEqual(harness.npm.get('proxy'), PROXY_A_PLAIN_URL);
        }

        // Without proxy-b's secret the gate skips: proxy-b cannot be written
        // without its credentials.
        {
            const harness = reloadHarness(originState);
            const reloaded = await harness.stateManager.getState();
            assert.ok(reloaded.autoHttpsProxyUrl && !reloaded.autoHttpsProxyUrl.includes('u2'));

            const activeUrl = reloaded.autoProxyUrl || '';
            const planOptions = resolveProxyApplyOptions(activeUrl, undefined, reloaded);
            assert.strictEqual(
                shouldSkipUnauthenticatedApply(reloaded, proxyApplyPlanUrls(activeUrl, planOptions)),
                true,
                'the apply must skip when proxy-b credentials are unavailable on this machine'
            );
        }
    });
});

suite('authRequiredProxyUrls lifecycle (#108)', () => {
    test('setRequiresAuthFromLiveUrls replaces the list from the live fields', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_CRED_URL,
            requiresAuth: true,
            authRequiredProxyUrls: ['http://stale.example.com:1/']
        };
        setRequiresAuthFromLiveUrls(state);
        assert.strictEqual(state.requiresAuth, true);
        assert.deepStrictEqual(state.authRequiredProxyUrls, [proxyAPublicUrl()]);
    });

    test('a credential-free live state clears the list together with requiresAuth', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_PLAIN_URL,
            requiresAuth: true,
            authRequiredProxyUrls: [proxyBPublicUrl()]
        };
        setRequiresAuthFromLiveUrls(state);
        assert.ok(!('requiresAuth' in state), 'requiresAuth must be cleared');
        assert.ok(!('authRequiredProxyUrls' in state), 'the list must be cleared');
    });

    test('persistence keeps the list for a partially hydrated state', () => {
        const sanitized = sanitizeProxyStateForPersistence({
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_PLAIN_URL,
            autoHttpProxyUrl: PROXY_A_PLAIN_URL,
            autoHttpsProxyUrl: proxyBPublicUrl(),
            requiresAuth: true,
            authRequiredProxyUrls: [proxyAPublicUrl(), proxyBPublicUrl()]
        });
        // proxy-a is still in a field so its entry survives even though it no
        // longer carries credentials; both entries stay because they still
        // appear in the state.
        assert.deepStrictEqual(sanitized.authRequiredProxyUrls, [proxyAPublicUrl(), proxyBPublicUrl()]);
    });

    test('a URL that leaves every field leaves the list', () => {
        const sanitized = sanitizeProxyStateForPersistence({
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_CRED_URL,
            authRequiredProxyUrls: [proxyAPublicUrl(), proxyBPublicUrl()]
        });
        assert.deepStrictEqual(sanitized.authRequiredProxyUrls, [proxyAPublicUrl()]);
    });

    test('no entry contains userinfo and the list is sorted', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_B_CRED_URL,
            fallbackProxyUrl: PROXY_A_CRED_URL
        };
        const derived = deriveAuthRequiredProxyUrls(state);
        assert.deepStrictEqual(derived, [...derived!].sort());
        for (const url of derived!) {
            assert.ok(!url.includes('@'), `list entry must not carry userinfo: ${url}`);
        }
    });

    test('a state persisted before the list existed comes out byte-identical', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: proxyAPublicUrl(),
            requiresAuth: true
        };
        const sanitized = sanitizeProxyStateForPersistence(state);
        assert.deepStrictEqual(sanitized, state);
        assert.strictEqual(JSON.stringify(sanitized), JSON.stringify(state));
    });
});

/**
 * Finding A (#108): the unauthenticated-apply gate used to run only at
 * startup and in the sync receiver, so the monitor's next apply wrote an
 * address without the credentials it could not restore. The per-address
 * check now runs inside runProxyApplyAttempt itself, before consent or any
 * write, for every trigger.
 */
suite('The per-address gate covers every apply (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let showWarning: sinon.SinonStub;
    let otakConfig: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = {
            notificationLevel: 'off',
            hostUserLockEnabled: false,
            diagnosticsEnabled: false
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    /** The persisted two-address split on a machine holding only proxy-a's secret. */
    async function partialReload(): Promise<Harness> {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(twoAddressCredSplitState());
        return reloadHarness(originState, new Map(
            [...originSecrets].filter(([key]) => key !== getCredentialKeyForPublicUrl(proxyBPublicUrl()))
        ));
    }

    for (const trigger of ['autoDetection', 'manual'] as const) {
        test(`${trigger}: the apply is refused when one split address cannot restore its credentials`, async () => {
            const harness = await partialReload();
            // proxy-a already has consent; without the gate the write would
            // proceed and write proxy-b without its credentials.
            harness.globalState.set(CONSENT_KEY, { [consentKeyFor(PROXY_A_CRED_URL)]: true });
            const reloaded = await harness.stateManager.getState();

            const result = await harness.applySafely(reloaded.autoProxyUrl!, true, trigger, { silent: true });

            assert.strictEqual(result.success, false);
            assert.strictEqual(showWarning.callCount, 0, 'the gate runs before consent, so no prompt');
            assertNothingWritten(harness);
            assert.strictEqual(
                (await harness.stateManager.getState()).lastError,
                UNRESOLVED_LOCAL_CREDENTIAL_ERROR
            );
        });
    }

    test('with both secrets restored the same call writes both credential-bearing URLs', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(twoAddressCredSplitState());
        const harness = reloadHarness(originState, originSecrets);
        harness.globalState.set(CONSENT_KEY, {
            [consentKeyFor(PROXY_A_CRED_URL)]: true,
            [consentKeyFor(PROXY_B_CRED_URL)]: true
        });
        const reloaded = await harness.stateManager.getState();

        const result = await harness.applySafely(reloaded.autoProxyUrl!, true, 'autoDetection', { silent: true });

        assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
        assert.strictEqual(harness.npm.get('proxy'), PROXY_A_CRED_URL);
        assert.strictEqual(harness.npm.get('https-proxy'), PROXY_B_CRED_URL);
        assert.strictEqual(harness.envVars.get('HTTPS_PROXY'), PROXY_B_CRED_URL);
    });

    test('the monitor reachability path is refused the same way and keeps its verdict', async () => {
        const harness = await partialReload();
        harness.globalState.set(CONSENT_KEY, { [consentKeyFor(PROXY_A_CRED_URL)]: true });
        const reloaded = await harness.stateManager.getState();
        assert.strictEqual(reloaded.autoProxyUrl, PROXY_A_CRED_URL);

        // The production wiring: the reachability handler's apply goes
        // through applyProxySettings, which is runProxyApplyAttempt.
        const context = {
            extensionContext: {} as never,
            proxyStateManager: harness.stateManager,
            proxyApplier: {} as never,
            applyProxySettings: async (url: string, enabled: boolean, options?: ProxyApplyOptions) =>
                (await harness.applySafely(url, enabled, 'autoDetection', options)).success,
            systemProxyDetector: {} as never,
            userNotifier: { showSuccess: () => {}, showWarning: () => {} } as never,
            sanitizer: new InputSanitizer(),
            proxyChangeLogger: {} as never,
            publishProxyState: async () => {}
        } as unknown as InitializerContext;

        await handleProxyStateChanged(context, {
            proxyUrl: PROXY_A_CRED_URL,
            reachable: true,
            previousState: false
        });

        assertNothingWritten(harness);
        const stored = await harness.stateManager.getState();
        assert.strictEqual(stored.lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR);
        assert.strictEqual(stored.proxyReachable, true, "the handler's reachability verdict stands");
    });
});

/** The two gate rules after the split (#108 finding A). */
suite('The unauthenticated-apply gate rules (#108)', () => {
    const sameHostPublicUrl = () => getProxyPublicUrl(SAME_HOST_URL)!;

    test('live same-host split (credentials on HTTPS only): no skip', () => {
        const state: ProxyState = {
            ...sameHostSplitState(),
            requiresAuth: true,
            authRequiredProxyUrls: [sameHostPublicUrl()]
        };
        const planUrls = proxyApplyPlanUrls(SAME_HOST_URL, splitApplyOptionsFromState(state));

        // The HTTPS URL carries the credentials for the shared address.
        assert.deepStrictEqual(planUrls, [SAME_HOST_URL, SAME_HOST_CRED_URL]);
        assert.deepStrictEqual(planUrlsMissingRequiredCredentials(state, planUrls), []);
        assert.strictEqual(shouldSkipUnauthenticatedApply(state, planUrls), false);
    });

    test('reloaded same-host split without the secret: skip', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(sameHostSplitState());
        const harness = reloadHarness(originState);
        const reloaded = await harness.stateManager.getState();
        assert.ok(reloaded.autoProxyUrl && !reloaded.autoProxyUrl.includes('secret'));

        const plan = resolveProxyApplyOptions(reloaded.autoProxyUrl!, undefined, reloaded);
        const planUrls = proxyApplyPlanUrls(reloaded.autoProxyUrl!, plan);
        assert.deepStrictEqual(planUrlsMissingRequiredCredentials(reloaded, planUrls), [sameHostPublicUrl()]);
        assert.strictEqual(shouldSkipUnauthenticatedApply(reloaded, planUrls), true);
    });

    test('credential-free system proxy with a credential-bearing manualProxyUrl, list present: no skip', () => {
        // requiresAuth is derived from all six URL fields, so the aggregate
        // rule alone would refuse this credential-free plan on the strength
        // of the unrelated manual URL (#108 background 4).
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_PLAIN_URL,
            manualProxyUrl: PROXY_B_CRED_URL,
            requiresAuth: true,
            authRequiredProxyUrls: [proxyBPublicUrl()]
        };
        const plan = resolveProxyApplyOptions(PROXY_A_PLAIN_URL, undefined, state);
        const planUrls = proxyApplyPlanUrls(PROXY_A_PLAIN_URL, plan);

        assert.deepStrictEqual(planUrlsMissingRequiredCredentials(state, planUrls), []);
        assert.strictEqual(
            shouldSkipUnauthenticatedApply(state, planUrls),
            false,
            'the per-address list decides; the aggregate rule must not refuse the credential-free plan'
        );
    });

    test('the same state without a list: shouldSkipUnauthenticatedApply skips, the per-address rule finds nothing missing', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: PROXY_A_PLAIN_URL,
            manualProxyUrl: PROXY_B_CRED_URL,
            requiresAuth: true
        };
        const planUrls = [PROXY_A_PLAIN_URL];

        assert.deepStrictEqual(planUrlsMissingRequiredCredentials(state, planUrls), []);
        assert.strictEqual(
            shouldSkipUnauthenticatedApply(state, planUrls),
            true,
            'a state saved before the list existed keeps the aggregate rule'
        );
    });

    test('two addresses with one missing: skip', async () => {
        const originState = new Map<string, unknown>();
        const originSecrets = new Map<string, string>();
        await new ProxyStateManager(fakeExtensionContext(originState, originSecrets))
            .saveState(twoAddressCredSplitState());
        const harness = reloadHarness(originState, new Map(
            [...originSecrets].filter(([key]) => key !== getCredentialKeyForPublicUrl(proxyBPublicUrl()))
        ));
        const reloaded = await harness.stateManager.getState();

        const plan = resolveProxyApplyOptions(reloaded.autoProxyUrl!, undefined, reloaded);
        const planUrls = proxyApplyPlanUrls(reloaded.autoProxyUrl!, plan);
        assert.deepStrictEqual(planUrlsMissingRequiredCredentials(reloaded, planUrls), [proxyBPublicUrl()]);
        assert.strictEqual(shouldSkipUnauthenticatedApply(reloaded, planUrls), true);
    });
});

/**
 * Finding C (#108): an apply result is recorded against the state it was
 * planned for. When another window commits a new desired state between the
 * fence check and the write, the result commit must be discarded instead of
 * landing on the new state and displacing the new state's own apply.
 */
suite('Apply results are recorded against the planned generation (#108)', () => {
    const OTHER_PLAIN_URL = 'http://proxy-other.example.com:3128';
    const NEW_PLAIN_URL = 'http://proxy-new.example.com:3128';
    let sandbox: sinon.SinonSandbox;
    let otakConfig: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        otakConfig = {
            notificationLevel: 'off',
            hostUserLockEnabled: false,
            diagnosticsEnabled: false
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => ({
            get: (key: string, defaultValue?: unknown) =>
                section === 'otakProxy' && key in otakConfig ? otakConfig[key] : defaultValue,
            update: async () => {},
            has: () => true,
            inspect: () => undefined
        })) as typeof vscode.workspace.getConfiguration);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('applyProxyDetailed after another writer moved the state past the basis commits nothing', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: HTTP_URL });
        const basis = captureLogicalGeneration(await harness.stateManager.getState());
        await harness.stateManager.saveState({
            ...(await harness.stateManager.getState()),
            autoProxyUrl: OTHER_PLAIN_URL
        });
        const otherRevision = stateRevision(await harness.stateManager.getState());

        const result = await harness.applier.applyProxyDetailed(HTTP_URL, true, { silent: true }, basis);

        assert.strictEqual(
            result.committedRevision,
            undefined,
            'the result commit must not land on the newer desired state'
        );
        const stored = await harness.stateManager.getState();
        assert.strictEqual(stateRevision(stored), otherRevision, "the stored revision is still the other writer's");
        assert.strictEqual(stored.autoProxyUrl, OTHER_PLAIN_URL);
        assert.strictEqual(stored.gitConfigured, undefined, 'the old plan leaves no result fields behind');
    });

    test('through runProxyApplyAttempt: the result commit is discarded and the new state\'s apply is not superseded', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: HTTP_URL });
        let otherWindowGeneration: LogicalGeneration | undefined;

        // Another window commits its new desired state between our fence
        // check and our write, then the real applier runs over the old plan.
        const delegate = async (proxyUrl: string, enabled: boolean, options?: ProxyApplyOptions, basis?: LogicalGeneration) => {
            await harness.stateManager.saveState({
                ...(await harness.stateManager.getState()),
                autoProxyUrl: NEW_PLAIN_URL
            });
            otherWindowGeneration = captureLogicalGeneration(await harness.stateManager.getState());
            return harness.applier.applyProxyDetailed(proxyUrl, enabled, options, basis);
        };

        const first = await runProxyApplyAttempt(
            harness.stateManager,
            delegate,
            harness.service,
            HTTP_URL,
            true,
            'autoDetection'
        );

        assert.strictEqual(
            first.applyResult?.committedRevision,
            undefined,
            'the old generation\'s result commit must be discarded'
        );
        const stored = await harness.stateManager.getState();
        assert.strictEqual(
            stateRevision(stored),
            otherWindowGeneration!.revision,
            "the stored revision is still the other window's"
        );
        assert.strictEqual(stored.gitConfigured, undefined, 'the old plan leaves no result fields behind');

        // The other window's own apply of the new state is not superseded by
        // our discarded result commit and writes the new URL.
        const otherWindowApply = createFencedApply(
            harness.stateManager,
            otherWindowGeneration!,
            'autoDetection',
            (u, e, o, b) => harness.applier.applyProxyDetailed(u, e, o, b)
        );
        const second = await otherWindowApply(NEW_PLAIN_URL, true, { silent: true });

        assert.notStrictEqual(second.superseded, true, 'the new state\'s apply must not be superseded');
        assert.strictEqual(second.committedRevision, otherWindowGeneration!.revision + 1);
        assert.strictEqual(harness.npm.get('proxy'), NEW_PLAIN_URL);
    });

    test('a disable through the enabled-to-disable delegation records against the basis too', async () => {
        // Positive control first: a current basis commits.
        {
            const harness = createHarness();
            await harness.stateManager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: HTTP_URL });
            const basis = captureLogicalGeneration(await harness.stateManager.getState());

            const result = await harness.applier.applyProxyDetailed('', false, { silent: true }, basis);

            assert.strictEqual(
                result.committedRevision,
                basis.revision + 1,
                'a current basis must commit (proves "undefined" below is staleness, not a no-commit path)'
            );
        }

        // The stale-basis case: another writer saves a newer state between
        // the fence check and the disable's result commit.
        {
            const harness = createHarness();
            await harness.stateManager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: HTTP_URL });
            const basis = captureLogicalGeneration(await harness.stateManager.getState());
            await harness.stateManager.saveState({
                ...(await harness.stateManager.getState()),
                autoProxyUrl: OTHER_PLAIN_URL
            });
            const otherRevision = stateRevision(await harness.stateManager.getState());

            const result = await harness.applier.applyProxyDetailed('', false, { silent: true }, basis);

            assert.strictEqual(
                result.committedRevision,
                undefined,
                'the disable\'s result commit must not land on the newer desired state'
            );
            const stored = await harness.stateManager.getState();
            assert.strictEqual(stateRevision(stored), otherRevision, "the stored revision is still the other writer's");
            assert.strictEqual(stored.autoProxyUrl, OTHER_PLAIN_URL);
            assert.strictEqual(stored.gitConfigured, undefined, 'the disable leaves no result fields behind');
        }
    });
});
