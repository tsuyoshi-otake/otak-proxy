import * as assert from 'assert';
import { ProxyApplier } from '../core/ProxyApplier';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';

const HTTP_A = 'http://proxy-a.example.com:8080';
const HTTPS_B = 'http://proxy-b.example.com:8443';

function createApplier(overrides: {
    git?: { setProxy: (url: string) => Promise<{ success: boolean }>; calls: string[] };
    vscode?: { setProxy: (url: string) => Promise<{ success: boolean }>; calls: string[] };
    npm?: {
        setProxy: (url: string) => Promise<{ success: boolean }>;
        setProxyKeys?: (values: { proxy?: string | null; 'https-proxy'?: string | null }) => Promise<{ success: boolean }>;
        keyCalls: Array<{ proxy?: string | null; 'https-proxy'?: string | null }>;
        urlCalls: string[];
    };
    terminal?: {
        setProxy: (url: string) => Promise<{ success: boolean }>;
        setProxyByScheme?: (httpUrl: string, httpsUrl: string) => Promise<{ success: boolean }>;
        schemeCalls: Array<{ httpUrl: string; httpsUrl: string }>;
        urlCalls: string[];
    };
}) {
    const gitCalls: string[] = [];
    const vscodeCalls: string[] = [];
    const npmUrlCalls: string[] = [];
    const npmKeyCalls: Array<{ proxy?: string | null; 'https-proxy'?: string | null }> = [];
    const terminalUrlCalls: string[] = [];
    const terminalSchemeCalls: Array<{ httpUrl: string; httpsUrl: string }> = [];

    const gitManager = overrides.git ?? {
        calls: gitCalls,
        setProxy: async (url: string) => {
            gitCalls.push(url);
            return { success: true };
        },
        unsetProxy: async () => ({ success: true })
    };

    const vscodeManager = overrides.vscode ?? {
        calls: vscodeCalls,
        setProxy: async (url: string) => {
            vscodeCalls.push(url);
            return { success: true };
        },
        unsetProxy: async () => ({ success: true })
    };

    const npmManager = overrides.npm ?? {
        urlCalls: npmUrlCalls,
        keyCalls: npmKeyCalls,
        setProxy: async (url: string) => {
            npmUrlCalls.push(url);
            return { success: true };
        },
        setProxyKeys: async (values: { proxy?: string | null; 'https-proxy'?: string | null }) => {
            npmKeyCalls.push(values);
            return { success: true };
        },
        unsetProxy: async () => ({ success: true })
    };

    const terminalManager = overrides.terminal ?? {
        urlCalls: terminalUrlCalls,
        schemeCalls: terminalSchemeCalls,
        setProxy: async (url: string) => {
            terminalUrlCalls.push(url);
            return { success: true };
        },
        setProxyByScheme: async (httpUrl: string, httpsUrl: string) => {
            terminalSchemeCalls.push({ httpUrl, httpsUrl });
            return { success: true };
        },
        unsetProxy: async () => ({ success: true })
    };

    const applier = new ProxyApplier(
        gitManager as never,
        vscodeManager as never,
        npmManager as never,
        new ProxyUrlValidator(),
        new InputSanitizer(),
        {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as never,
        undefined,
        terminalManager as never
    );

    return { applier, gitCalls, vscodeCalls, npmUrlCalls, npmKeyCalls, terminalUrlCalls, terminalSchemeCalls };
}

suite('ProxyApplier split contract #56', () => {
    setup(() => {
        I18nManager.getInstance().initialize('en');
    });

    test('npm and terminal receive distinct HTTP and HTTPS URLs', async () => {
        const { applier, npmKeyCalls, npmUrlCalls, terminalSchemeCalls, terminalUrlCalls } = createApplier({});

        const result = await applier.applyProxyDetailed(HTTP_A, true, {
            kind: 'perSchemeProxy',
            httpUrl: HTTP_A,
            httpsUrl: HTTPS_B
        });

        assert.deepStrictEqual(npmKeyCalls, [{ proxy: HTTP_A, 'https-proxy': HTTPS_B }]);
        assert.deepStrictEqual(npmUrlCalls, []);
        assert.deepStrictEqual(terminalSchemeCalls, [{ httpUrl: HTTP_A, httpsUrl: HTTPS_B }]);
        assert.deepStrictEqual(terminalUrlCalls, []);
        assert.ok(result.issues?.some(issue => issue.id === 'git.splitProxy.notRepresentable'));
        assert.ok(result.issues?.some(issue => issue.id === 'vscode.splitProxy.notRepresentable'));
    });

    test('Git and VS Code receive one URL plus a lossy capability issue', async () => {
        const { applier, gitCalls, vscodeCalls } = createApplier({});

        const result = await applier.applyProxyDetailed(HTTP_A, true, {
            kind: 'perSchemeProxy',
            httpUrl: HTTP_A,
            httpsUrl: HTTPS_B
        });

        assert.deepStrictEqual(gitCalls, [HTTP_A]);
        assert.deepStrictEqual(vscodeCalls, [HTTP_A]);
        const gitIssue = result.issues?.find(issue => issue.id === 'git.splitProxy.notRepresentable');
        const vscodeIssue = result.issues?.find(issue => issue.id === 'vscode.splitProxy.notRepresentable');
        assert.ok(gitIssue);
        assert.ok(vscodeIssue);
        assert.strictEqual(gitIssue.evidence.httpsUrl, `${HTTPS_B}/`);
        assert.strictEqual(vscodeIssue.evidence.httpsUrl, `${HTTPS_B}/`);
        // Read-back of the written URL is not routing proof.
        assert.notStrictEqual(gitIssue.evidence.gitRouting, 'https.proxy');
    });

    test('single URL apply does not invent split writes', async () => {
        const { applier, npmKeyCalls, npmUrlCalls, gitCalls } = createApplier({});

        const result = await applier.applyProxyDetailed(HTTP_A, true);

        assert.deepStrictEqual(npmUrlCalls, [HTTP_A]);
        assert.deepStrictEqual(npmKeyCalls, []);
        assert.deepStrictEqual(gitCalls, [HTTP_A]);
        assert.ok(!result.issues?.some(issue => issue.id === 'git.splitProxy.notRepresentable'));
    });
});
