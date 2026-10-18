/**
 * Echo suppression tests (issue #29)
 *
 * The extension writes the active proxy into VS Code's `http.proxy`; the
 * `vscode` detection source then re-reads that value and used to report it
 * as a system proxy, shadowing platform detection and destroying the
 * fallback display. These tests pin the suppression rules of Plan D:
 * suppress only when the candidate equals the currently applied URL in
 * canonical form — credentials included — or carries no credentials and
 * names the same proxy address (this extension's own detection write is
 * credential-free), AND the applied URL's provenance is known and is
 * not 'vscode'. A candidate with different or added credentials is not an
 * echo (#108).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { AppliedProxyInfo, SystemProxyDetector } from '../config/SystemProxyDetector';
import { appliedProxyInfoFromState } from '../core/AppliedProxyProvenance';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { sameProxyUrlWithCredentials } from '../utils/ProxyUrlIdentity';

suite('SystemProxyDetector echo suppression (issue #29)', () => {
    let sandbox: sinon.SinonSandbox;
    let httpProxyValue: string | undefined;
    let otakProxyValues: Record<string, unknown>;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        sandbox = sinon.createSandbox();
        httpProxyValue = undefined;
        otakProxyValues = {};

        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => {
            if (section === 'http') {
                return {
                    get: (key: string) => (key === 'proxy' ? httpProxyValue : undefined),
                    has: () => true,
                    inspect: () => undefined,
                    update: () => Promise.resolve()
                } as unknown as vscode.WorkspaceConfiguration;
            }
            return {
                get: (key: string, defaultValue?: unknown) =>
                    Object.prototype.hasOwnProperty.call(otakProxyValues, key)
                        ? otakProxyValues[key]
                        : defaultValue,
                has: () => true,
                inspect: () => undefined,
                update: () => Promise.resolve()
            } as unknown as vscode.WorkspaceConfiguration;
        }) as typeof vscode.workspace.getConfiguration);
    });

    teardown(() => {
        sandbox.restore();
    });

    function createDetector(applied?: AppliedProxyInfo | (() => Promise<AppliedProxyInfo | undefined>)): SystemProxyDetector {
        // 'vscode' only: keeps the test hermetic (no env/registry reads).
        const detector = new SystemProxyDetector(['vscode']);
        if (applied !== undefined) {
            detector.setAppliedProxyProvider(
                typeof applied === 'function' ? applied : async () => applied
            );
        }
        return detector;
    }

    test('suppresses the value this extension applied (known non-vscode provenance)', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = createDetector({ url: 'http://192.168.199.2:8888', source: 'fallback' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.source, null);
    });

    test('suppressed vscode value falls through to later sources', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = new SystemProxyDetector(['vscode', 'environment']);
        detector.setAppliedProxyProvider(async () => ({ url: 'http://192.168.199.2:8888', source: 'fallback' }));

        const originalHttpProxy = process.env.HTTP_PROXY;
        process.env.HTTP_PROXY = 'http://real-system.example.com:3128';
        try {
            const result = await detector.detectSystemProxyWithSource();
            assert.strictEqual(result.proxyUrl, 'http://real-system.example.com:3128');
            assert.strictEqual(result.source, 'environment');
        } finally {
            if (originalHttpProxy === undefined) {
                delete process.env.HTTP_PROXY;
            } else {
                process.env.HTTP_PROXY = originalHttpProxy;
            }
        }
    });

    test('does NOT suppress when provenance is unknown (pre-3.2.2 state / hand-set http.proxy)', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = createDetector({ url: 'http://192.168.199.2:8888', source: undefined });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://192.168.199.2:8888');
        assert.strictEqual(result.source, 'vscode');
    });

    test("does NOT suppress when the applied URL's provenance is 'vscode' itself", async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = createDetector({ url: 'http://192.168.199.2:8888', source: 'vscode' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://192.168.199.2:8888');
        assert.strictEqual(result.source, 'vscode');
    });

    test('does NOT suppress a different URL (user changed http.proxy manually)', async () => {
        httpProxyValue = 'http://other-proxy.example.com:9999';
        const detector = createDetector({ url: 'http://192.168.199.2:8888', source: 'fallback' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://other-proxy.example.com:9999');
        assert.strictEqual(result.source, 'vscode');
    });

    test('suppresses the identical credential-bearing value this extension applied (#108)', async () => {
        httpProxyValue = 'http://user:s3cr3t@proxy.example.com:8080';
        const detector = createDetector({ url: 'http://user:s3cr3t@proxy.example.com:8080', source: 'windows' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.source, null);
    });

    test('suppresses a credential-less candidate for the applied address — our own detection write carries no credentials (#108)', async () => {
        httpProxyValue = 'http://proxy.example.com:8080';
        const detector = createDetector({ url: 'http://user:s3cr3t@proxy.example.com:8080', source: 'windows' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.source, null);
    });

    test('does NOT suppress a candidate that adds credentials to a credential-free applied URL (#108)', async () => {
        httpProxyValue = 'http://user:s3cr3t@proxy.example.com:8080';
        const detector = createDetector({ url: 'http://proxy.example.com:8080', source: 'windows' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://user:s3cr3t@proxy.example.com:8080');
        assert.strictEqual(result.source, 'vscode');
    });

    test('does NOT suppress same host:port with different credentials (#108)', async () => {
        httpProxyValue = 'http://other:pw@proxy.example.com:8080';
        const detector = createDetector({ url: 'http://user:s3cr3t@proxy.example.com:8080', source: 'windows' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://other:pw@proxy.example.com:8080');
        assert.strictEqual(result.source, 'vscode');
    });

    test('does NOT suppress when no applied-proxy provider is registered', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = createDetector();

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://192.168.199.2:8888');
        assert.strictEqual(result.source, 'vscode');
    });

    test('escape hatch: otakProxy.ignoreSelfWrittenVSCodeProxy=false disables suppression', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        otakProxyValues['ignoreSelfWrittenVSCodeProxy'] = false;
        const detector = createDetector({ url: 'http://192.168.199.2:8888', source: 'fallback' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://192.168.199.2:8888');
        assert.strictEqual(result.source, 'vscode');
    });

    test('a failing provider disables suppression instead of breaking detection', async () => {
        httpProxyValue = 'http://192.168.199.2:8888';
        const detector = createDetector(async () => {
            throw new Error('state store unavailable');
        });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://192.168.199.2:8888');
        assert.strictEqual(result.source, 'vscode');
    });

    // Regression (#108): a platform-detected credential-free proxy whose
    // address holds credentials in SecretStorage (here via manualProxyUrl).
    // The provider's URL is hydrated with those credentials, while this
    // extension's own detection write to http.proxy carried none — the
    // credential-free value must still be recognized as the echo.
    test('credential-free http.proxy for the applied address is our own detection write, not user input', async () => {
        const globalState = new Map<string, unknown>();
        const secrets = new Map<string, string>();
        const context = {
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
        const stateManager = new ProxyStateManager(context);
        await stateManager.saveState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://corp.example.com:8080',
            manualProxyUrl: 'http://user:pass@corp.example.com:8080',
            lastDetectionSource: 'windows'
        });

        const applied = appliedProxyInfoFromState(await stateManager.getState());
        assert.ok(applied, 'provider must report an applied proxy');
        assert.strictEqual(
            applied.url,
            'http://user:pass@corp.example.com:8080',
            'the applied URL must be hydrated with the stored credentials for this address'
        );

        // This extension's own detection write carries no credentials.
        httpProxyValue = 'http://corp.example.com:8080';
        const echoResult = await createDetector(applied).detectSystemProxyWithSource();
        assert.strictEqual(echoResult.proxyUrl, null, 'the credential-free own write must be suppressed');
        assert.strictEqual(echoResult.source, null);

        // A hand-set value with different credentials for the same address is
        // not an echo.
        httpProxyValue = 'http://other:pw@corp.example.com:8080';
        const manualResult = await createDetector(applied).detectSystemProxyWithSource();
        assert.strictEqual(manualResult.proxyUrl, 'http://other:pw@corp.example.com:8080');
        assert.strictEqual(manualResult.source, 'vscode');
    });
});

suite('sameProxyUrlWithCredentials (#108)', () => {
    const cases: Array<{ left: string; right: string; equal: boolean; label: string }> = [
        // Same proxy, same credentials: spelling differences must still match.
        { left: 'http://u:p@PROXY.EXAMPLE.COM:8080', right: 'http://u:p@proxy.example.com:8080', equal: true, label: 'host case' },
        { left: 'HTTP://u:p@proxy.example.com:8080', right: 'http://u:p@proxy.example.com:8080', equal: true, label: 'scheme case' },
        { left: 'http://u:p@proxy.example.com:80', right: 'http://u:p@proxy.example.com', equal: true, label: 'default http port' },
        { left: 'https://u:p@proxy.example.com:443', right: 'https://u:p@proxy.example.com', equal: true, label: 'default https port' },
        { left: 'http://u:p@proxy.example.com:8080/', right: 'http://u:p@proxy.example.com:8080', equal: true, label: 'trailing slash' },
        { left: 'http://u:p%40ss@proxy.example.com', right: 'http://u:p@ss@proxy.example.com', equal: true, label: 'percent-encoded vs plain userinfo' },
        { left: 'http://u:p%ss@proxy.example.com', right: 'http://u:p%25ss@proxy.example.com', equal: true, label: 'stray % vs %25' },
        { left: 'not a url', right: 'not a url', equal: true, label: 'unparsable identical text' },

        // Not the same value: different credentials or a different address.
        { left: 'http://u:p@proxy.example.com', right: 'http://u:p2@proxy.example.com', equal: false, label: 'another password' },
        { left: 'http://u:p@proxy.example.com', right: 'http://u2:p@proxy.example.com', equal: false, label: 'another username' },
        { left: 'http://u:p@proxy.example.com', right: 'http://proxy.example.com', equal: false, label: 'credentials vs none' },
        { left: 'http://u:p@proxy.example.com:8080', right: 'http://u:p@proxy.example.com:8081', equal: false, label: 'another port' },
        { left: 'http://u:p@proxy.example.com', right: 'http://u:p@other.example.com', equal: false, label: 'another host' },
        { left: 'http://u:p@[::1]:8080', right: 'http://u:p@[::1]:8081', equal: false, label: 'bracketed IPv6, another port' },
        { left: 'http://u:p@proxy.example.com', right: 'https://u:p@proxy.example.com', equal: false, label: 'another scheme' },
        { left: 'not a url', right: 'other text', equal: false, label: 'unparsable different text' }
    ];

    for (const { left, right, equal, label } of cases) {
        test(`${label}: ${left} vs ${right}`, () => {
            assert.strictEqual(sameProxyUrlWithCredentials(left, right), equal);
            assert.strictEqual(sameProxyUrlWithCredentials(right, left), equal, 'identity must be symmetric');
        });
    }
});
