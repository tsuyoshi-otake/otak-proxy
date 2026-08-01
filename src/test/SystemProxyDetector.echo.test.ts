/**
 * Echo suppression tests (issue #29)
 *
 * The extension writes the active proxy into VS Code's `http.proxy`; the
 * `vscode` detection source then re-reads that value and used to report it
 * as a system proxy, shadowing platform detection and destroying the
 * fallback display. These tests pin the suppression rules of Plan D:
 * suppress only when the candidate matches the currently applied URL
 * (credential-stripped) AND the applied URL's provenance is known and is
 * not 'vscode'.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SystemProxyDetector, AppliedProxyInfo } from '../config/SystemProxyDetector';

suite('SystemProxyDetector echo suppression (issue #29)', () => {
    let sandbox: sinon.SinonSandbox;
    let httpProxyValue: string | undefined;
    let otakProxyValues: Record<string, unknown>;

    setup(() => {
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

    test('matches on credential-stripped public form (applied URL carries credentials)', async () => {
        httpProxyValue = 'http://proxy.example.com:8080';
        const detector = createDetector({ url: 'http://user:s3cr3t@proxy.example.com:8080', source: 'windows' });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.source, null);
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
});
