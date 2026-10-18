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
import { ProxyApplier } from '../core/ProxyApplier';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { resolveProxyApplyOptions, proxyApplyPlanCredentialUrls, proxyApplyPlanUrls } from '../core/ProxyApplyPlan';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { SystemProxyUpdateService } from '../core/SystemProxyUpdateService';
import { publicFingerprint } from '../core/TargetOwnershipStore';
import { InitializerContext } from '../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState } from '../core/types';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { ProxyRemediationService, ProxyApplyTrigger } from '../remediation/ProxyRemediationService';
import { runProxyApplyAttempt } from '../remediation/ProxyApplyAttempt';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../sync/RemoteSyncStateApplier';
import * as SystemProxyDetectionUtils from '../utils/SystemProxyDetectionUtils';
import {
    removeProxyCredentials,
    shouldSkipUnauthenticatedApply,
    UNRESOLVED_LOCAL_CREDENTIAL_ERROR
} from '../utils/ProxyStateSanitizer';
import { createFakeGitConfig, createFakeNpmConfig } from './fakeConfigStores';

const HTTP_URL = 'http://proxy-http.example.com:3128';
const HTTPS_CRED_URL = 'http://user:secret@proxy-https.example.com:3128';
const OTHER_CRED_URL = 'http://other:pw@other.example.com:9999';
// The brief's own reproduction: ONE proxy for both schemes, credentials on
// HTTPS only (HTTP_PROXY=http://proxy:3128, HTTPS_PROXY=http://user:secret@proxy:3128).
const SAME_HOST_URL = 'http://proxy.example.com:3128';
const SAME_HOST_CRED_URL = 'http://user:secret@proxy.example.com:3128';
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

function createHarness(): Harness {
    const globalState = new Map<string, unknown>();
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
            (proxyUrl, shouldEnable, applyOptions) => applier.applyProxyDetailed(proxyUrl, shouldEnable, applyOptions),
            service,
            url,
            enabled,
            trigger,
            options
        );

    return { globalState, secrets, stateManager, git, npm, envVars, vscodeSetCalls, applySafely };
}

function assertNothingWritten(harness: Harness): void {
    assert.strictEqual(harness.npm.get('proxy'), null, 'npm proxy must not be written');
    assert.strictEqual(harness.npm.get('https-proxy'), null, 'npm https-proxy must not be written');
    assert.strictEqual(harness.git.get('http.proxy'), null, 'git http.proxy must not be written');
    assert.deepStrictEqual(harness.vscodeSetCalls, [], 'vscode http.proxy must not be written');
    assert.strictEqual(harness.envVars.size, 0, 'terminal environment must not be written');
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

    test('the apply writes only the judged URLs even when state moves under the open prompt', async () => {
        const harness = createHarness();
        await harness.stateManager.saveState(splitState());

        // While the consent prompt is open, later state reads return a
        // different credential-bearing HTTPS URL at the same revision and
        // logical identity — e.g. credentials re-hydrated from SecretStorage.
        // The getState stub stands in for that (calling through to the real
        // read, then swapping the field). A saveState here would bump the
        // revision and the fence would drop the apply — a different
        // invariant. The apply may still write, but only the URLs consent
        // judged.
        showWarning.callsFake(async (_message: unknown, ...items: unknown[]) => {
            const original = harness.stateManager.getState.bind(harness.stateManager);
            sandbox.stub(harness.stateManager, 'getState').callsFake(async () => ({
                ...(await original()),
                autoHttpsProxyUrl: OTHER_CRED_URL
            }));
            return items[0] as never;
        });

        const result = await harness.applySafely(HTTP_URL, true, 'autoDetection');

        assert.strictEqual(result.success, true, JSON.stringify(result.applyResult?.errors));
        assert.strictEqual(
            harness.npm.get('https-proxy'),
            HTTPS_CRED_URL,
            'the judged URL is the only one consent approved; the new unjudged URL must not be written'
        );
        assert.notStrictEqual(harness.npm.get('https-proxy'), OTHER_CRED_URL);
        assert.strictEqual(harness.envVars.get('HTTPS_PROXY'), HTTPS_CRED_URL);
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
