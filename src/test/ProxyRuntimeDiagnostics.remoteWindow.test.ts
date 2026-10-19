/**
 * @file ProxyRuntimeDiagnostics.remoteWindow.test.ts
 * @description In a remote window otak-proxy never writes the VS Code user
 * setting http.proxy (#108), so Diagnose must not judge it: an unwritten value
 * is neither a mismatch nor a managed residual, and an advisory says why.
 * Host lane: the execution context reads vscode.env.remoteName, which only the
 * extension host provides, and the diagnostics read the http configuration.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';

const EXPECTED_URL = 'http://expected.example.com:8080';
const STALE_URL = 'http://stale.example.com:8080';

const ACTIVE_AUTO: ProxyState = {
    mode: ProxyMode.Auto,
    autoProxyUrl: EXPECTED_URL,
    autoModeOff: false,
    gitConfigured: true,
    npmConfigured: false,
    vscodeConfigured: true
};
const OFF_WITH_LEFTOVER: ProxyState = {
    mode: ProxyMode.Off,
    gitConfigured: false,
    npmConfigured: false,
    vscodeConfigured: false
};

suite('ProxyRuntimeDiagnostics in a remote window (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let remoteName: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        remoteName = sandbox.stub(vscode.env, 'remoteName').value(undefined);
        const original = vscode.workspace.getConfiguration.bind(vscode.workspace);
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((section?: string) => {
            if (section === 'http') {
                return {
                    get: (key: string, defaultValue?: unknown) => {
                        if (key === 'proxy') { return STALE_URL; }
                        if (key === 'proxySupport') { return 'on'; }
                        if (key === 'noProxy') { return []; }
                        return defaultValue;
                    },
                    inspect: () => undefined,
                    has: () => true,
                    update: async () => {}
                } as unknown as vscode.WorkspaceConfiguration;
            }
            if (section === 'otakProxy') {
                return {
                    get: (_key: string, defaultValue?: unknown) => defaultValue,
                    inspect: () => undefined,
                    has: () => true,
                    update: async () => {}
                } as unknown as vscode.WorkspaceConfiguration;
            }
            return original(section);
        }) as typeof vscode.workspace.getConfiguration);
    });

    teardown(() => {
        sandbox.restore();
    });

    async function report(state: ProxyState, remote: string | undefined) {
        remoteName.value(remote);
        const diagnostics = new ProxyRuntimeDiagnostics(
            { extension: { extensionKind: vscode.ExtensionKind.Workspace } } as unknown as vscode.ExtensionContext,
            async () => state,
            { commandRunner: async () => ({ stdout: '', stderr: '' }) }
        );
        return diagnostics.run({ bypassSlowCache: true });
    }

    test('Auto on, remote window: no http.proxy mismatch, the advisory is present, the other targets are still judged', async () => {
        for (const remote of ['ssh-remote', 'wsl', 'dev-container']) {
            const result = await report(ACTIVE_AUTO, remote);
            const ids = result.issues.map(issue => issue.id);

            assert.ok(!ids.includes('vscode.managedProxyMismatch'), `${remote}: ${ids.join(', ')}`);
            assert.ok(!ids.includes('vscode.managedProxyResidual'), `${remote}: ${ids.join(', ')}`);
            const advisory = result.issues.find(issue => issue.id === 'vscode.remoteExtensionHost.notWritable');
            assert.ok(advisory, `${remote}: the advisory is missing: ${ids.join(', ')}`);
            assert.strictEqual(advisory.category, 'capabilityUnavailable');
            assert.strictEqual(advisory.impact, 'advisoryResidualRisk');
            assert.strictEqual(advisory.targetId, 'vscode.http.proxy');
            assert.strictEqual(advisory.targetHost, 'remote');
            assert.strictEqual(advisory.source, 'executionContext');
            assert.ok(ids.includes('git.managedProxyMismatch'), `${remote}: git is still judged: ${ids.join(', ')}`);
        }
    });

    test('Off, remote window: a leftover http.proxy is not reported as a managed residual', async () => {
        const result = await report(OFF_WITH_LEFTOVER, 'ssh-remote');
        const ids = result.issues.map(issue => issue.id);

        assert.ok(!ids.includes('vscode.managedProxyResidual'), ids.join(', '));
        assert.ok(!ids.includes('vscode.managedProxyMismatch'), ids.join(', '));
    });

    test('control: the same Auto state in a local window still reports the http.proxy mismatch', async () => {
        const result = await report(ACTIVE_AUTO, undefined);
        const ids = result.issues.map(issue => issue.id);

        assert.ok(ids.includes('vscode.managedProxyMismatch'), ids.join(', '));
        assert.ok(!ids.includes('vscode.remoteExtensionHost.notWritable'), ids.join(', '));
    });

    test('control: the same Off state in a local window still reports the http.proxy residual', async () => {
        const result = await report(OFF_WITH_LEFTOVER, undefined);
        const ids = result.issues.map(issue => issue.id);

        assert.ok(ids.includes('vscode.managedProxyResidual'), ids.join(', '));
        assert.ok(!ids.includes('vscode.remoteExtensionHost.notWritable'), ids.join(', '));
    });
});
