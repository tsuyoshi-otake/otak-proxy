/**
 * @file ProxyRuntimeDiagnostics.requiresAuth.test.ts
 * @description The diagnostics credential checks must agree with the apply
 * gate per address (#139): `state.requiresAuth` is an aggregate over every URL
 * field, so a credential-bearing fallback must not claim the credential-free
 * active URL needs credentials, and must not hide a real git mismatch by
 * dropping the expected URL. Unit lane: the vscode module is the repo shim.
 * The shim lacks the members diagnostics reads (UIKind/ExtensionKind drive the
 * execution context, window.terminals feeds the terminal observation, and the
 * http configuration needs `inspect`), so it is patched below before the
 * production modules are required; `__importStar` binds top-level keys once at
 * require time, so any module that may already be cached from an earlier file
 * in this worker is dropped and re-required against the patched shim.
 * Everything patched or dropped is recorded and restored in suiteTeardown so
 * the next file in this Mocha worker sees the shim and cache as before.
 */
import * as assert from 'assert';
import Module = require('module');
import { ProxyMode, ProxyState } from '../core/types';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';
import type { CommandRunner } from '../diagnostics/WindowsProxyDiagnostics';
import type { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';

type VscodeStub = {
    UIKind?: { Desktop: number; Web: number };
    ExtensionKind?: { UI: number; Workspace: number };
    env: { language: string; uiKind?: number; remoteName?: string };
    window: { terminals?: unknown[] };
    workspace: {
        isTrusted?: boolean;
        getConfiguration: (section?: string) => {
            get: (key: string, defaultValue?: unknown) => unknown;
            inspect: () => undefined;
            update: () => Promise<void>;
        };
    };
};

const vscode = (Module as unknown as { _load(request: string, parent: unknown): unknown })
    ._load('vscode', module) as VscodeStub;

// Record every shim member this file touches before mutating it; a --parallel
// worker reuses the shim singleton for the files that run after this one.
const changedShimMembers: Array<{
    target: Record<string, unknown>;
    key: string;
    existed: boolean;
    value: unknown;
}> = [];
const rememberShimMember = (target: object, key: string): void => {
    const record = target as Record<string, unknown>;
    changedShimMembers.push({ target: record, key, existed: key in record, value: record[key] });
};
rememberShimMember(vscode, 'UIKind');
rememberShimMember(vscode, 'ExtensionKind');
rememberShimMember(vscode.env, 'uiKind');
rememberShimMember(vscode.env, 'remoteName');
rememberShimMember(vscode.window, 'terminals');
rememberShimMember(vscode.workspace, 'isTrusted');
rememberShimMember(vscode.workspace, 'getConfiguration');

vscode.UIKind = { Desktop: 1, Web: 2 };
vscode.ExtensionKind = { UI: 1, Workspace: 2 };
vscode.env.uiKind = vscode.UIKind.Desktop;
vscode.env.remoteName = undefined;
vscode.window.terminals = [];
vscode.workspace.isTrusted = true;
vscode.workspace.getConfiguration = () => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    inspect: () => undefined,
    update: async () => undefined
});

const droppedCacheEntries: Array<{ resolved: string; previous: NodeModule | undefined }> = [];
for (const specifier of [
    '../diagnostics/ExecutionContextDetector',
    '../diagnostics/ProxyRuntimeDiagnostics'
]) {
    const resolved = require.resolve(specifier);
    droppedCacheEntries.push({ resolved, previous: require.cache[resolved] });
    delete require.cache[resolved];
}
const { ProxyRuntimeDiagnostics: Diagnostics } =
    require('../diagnostics/ProxyRuntimeDiagnostics') as { ProxyRuntimeDiagnostics: typeof ProxyRuntimeDiagnostics };

const SYSTEM_PROXY_URL = 'http://sysproxy.corp:3128';
const STALE_GIT_PROXY_URL = 'http://stale.corp:9999';

function contextWithEmptySecrets(): ConstructorParameters<typeof Diagnostics>[0] {
    const secrets = new Map<string, string>();
    return {
        extension: { extensionKind: vscode.ExtensionKind!.Workspace },
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); }
        }
    } as unknown as ConstructorParameters<typeof Diagnostics>[0];
}

// git's http.proxy holds a stale value; npm already matches the expected URL;
// Windows diagnostics and other git keys are unavailable (exit 1).
function staleGitRunner(): CommandRunner {
    return async (command, args) => {
        if (command === 'git') {
            if (args.join(' ') === 'config --global --get http.proxy') {
                return { stdout: `${STALE_GIT_PROXY_URL}\n`, stderr: '' };
            }
            const unset = new Error('unset') as Error & { code?: number };
            unset.code = 1;
            throw unset;
        }
        if (command === 'reg' || command === 'netsh') {
            const unavailable = new Error('unavailable') as Error & { code?: number };
            unavailable.code = 1;
            throw unavailable;
        }
        return {
            stdout: JSON.stringify({ proxy: SYSTEM_PROXY_URL, 'https-proxy': SYSTEM_PROXY_URL }),
            stderr: ''
        };
    };
}

function appliedAutoState(overrides: Partial<ProxyState>): ProxyState {
    return {
        mode: ProxyMode.Auto,
        autoModeOff: false,
        autoProxyUrl: SYSTEM_PROXY_URL,
        gitConfigured: true,
        npmConfigured: true,
        vscodeConfigured: false,
        targetOutcomes: { git: 'applied', npm: 'applied', vscode: 'applied' },
        ...overrides
    } as ProxyState;
}

suite('Diagnostics credential check agrees with the apply gate (#139)', () => {
    // Put the shim singleton and the require cache back the way this file
    // found them: members it added are deleted, members it replaced get their
    // original value, and evicted cache entries are restored (or the freshly
    // patched modules removed when nothing was cached before).
    suiteTeardown(() => {
        for (const { target, key, existed, value } of changedShimMembers) {
            if (existed) {
                target[key] = value;
            } else {
                delete target[key];
            }
        }
        for (const { resolved, previous } of droppedCacheEntries) {
            if (previous) {
                require.cache[resolved] = previous;
            } else {
                delete require.cache[resolved];
            }
        }
    });

    test('an unrelated credentialed URL does not hide a real git mismatch or claim the active URL needs credentials', async () => {
        // Issue repro: a credential-free system proxy is active while a
        // credential-bearing manual URL raised the aggregate flag.
        const diagnostics = new Diagnostics(
            contextWithEmptySecrets(),
            async () => appliedAutoState({
                manualProxyUrl: 'http://alice:s3cret@fallback.corp:8080',
                requiresAuth: true,
                authRequiredProxyUrls: ['http://fallback.corp:8080/']
            }),
            { commandRunner: staleGitRunner() }
        );

        const report = await diagnostics.run({ bypassSlowCache: true });
        assert.ok(
            !report.issues.some(issue => issue.id === 'proxy.localCredential.unresolved'),
            'the credential-free system proxy must not be reported as needing credentials'
        );
        assert.ok(
            report.issues.some(issue => issue.id === 'git.managedProxyMismatch' && issue.impact === 'blocksConvergence'),
            'the stale git value the aggregate flag hid is a managed mismatch'
        );
        assert.strictEqual(report.converged, false);
    });

    test('control: the same state without any credential reports the same mismatch', async () => {
        const diagnostics = new Diagnostics(
            contextWithEmptySecrets(),
            async () => appliedAutoState({ manualProxyUrl: 'http://fallback.corp:8080' }),
            { commandRunner: staleGitRunner() }
        );

        const report = await diagnostics.run({ bypassSlowCache: true });
        assert.ok(
            report.issues.some(issue => issue.id === 'git.managedProxyMismatch' && issue.impact === 'blocksConvergence')
        );
        assert.strictEqual(report.converged, false);
    });

    test('a credential the expected address really requires is still reported', async () => {
        // The apply gate skipped this write and recorded the error; the
        // credential issue must fire and the skipped write's expected URL must
        // not judge the stale git value.
        const diagnostics = new Diagnostics(
            contextWithEmptySecrets(),
            async () => appliedAutoState({
                requiresAuth: true,
                authRequiredProxyUrls: [`${SYSTEM_PROXY_URL}/`],
                lastError: 'Proxy credentials are required but unavailable on this machine'
            }),
            { commandRunner: staleGitRunner() }
        );

        const report = await diagnostics.run({ bypassSlowCache: true });
        assert.ok(
            report.issues.some(issue => issue.id === 'proxy.localCredential.unresolved'),
            'a credential the active address requires but this machine lacks is still reported'
        );
        assert.ok(
            !report.issues.some(issue => issue.id === 'git.managedProxyMismatch'),
            'a write the apply gate skipped has no expected value to mismatch'
        );
        assert.strictEqual(report.converged, false);
    });

    test('an unresolved companion scheme credential is reported even when the primary resolves (#139)', async () => {
        // A per-scheme plan writes two addresses and the apply gate skips the
        // whole plan when EITHER lacks credentials, so resolving only the
        // primary URL hides the unresolved companion.
        const context = contextWithEmptySecrets();
        await new ProxyCredentialStore(context.secrets)
            .storeFromProxyUrl('http://user:pw@sysproxy.corp:3128');
        const diagnostics = new Diagnostics(
            context,
            async () => appliedAutoState({
                autoProxyKind: 'perSchemeProxy',
                autoHttpProxyUrl: SYSTEM_PROXY_URL,
                autoHttpsProxyUrl: 'https://secure.corp:3129',
                requiresAuth: true,
                authRequiredProxyUrls: [`${SYSTEM_PROXY_URL}/`, 'https://secure.corp:3129/'],
                lastError: 'Proxy credentials are required but unavailable on this machine'
            }),
            { commandRunner: staleGitRunner() }
        );

        const report = await diagnostics.run({ bypassSlowCache: true });
        const credentialIssue = report.issues.find(issue => issue.id === 'proxy.localCredential.unresolved');
        assert.ok(
            credentialIssue,
            'the companion address the plan cannot write without credentials must be reported'
        );
        assert.strictEqual(
            credentialIssue!.expectedSanitized,
            'https://secure.corp:3129/',
            'the issue names the unresolved address, not the resolvable primary'
        );
        assert.strictEqual(report.converged, false);
    });
});
