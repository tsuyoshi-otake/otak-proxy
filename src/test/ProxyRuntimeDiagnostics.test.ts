import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { CommandRunner } from '../diagnostics/WindowsProxyDiagnostics';

function createContext(): vscode.ExtensionContext {
    return {
        extension: {
            extensionKind: vscode.ExtensionKind.Workspace
        }
    } as unknown as vscode.ExtensionContext;
}

function stubOtakProxyConfiguration(): () => void {
    const original = vscode.workspace.getConfiguration;
    (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration =
        ((section?: string) => {
            if (section === 'otakProxy') {
                return {
                    get: (_key: string, defaultValue?: unknown) => defaultValue
                } as unknown as vscode.WorkspaceConfiguration;
            }
            return original(section);
        }) as typeof vscode.workspace.getConfiguration;

    return () => {
        (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration = original;
    };
}

suite('ProxyRuntimeDiagnostics Test Suite', () => {
    test('uses one npm config snapshot for concurrent slow diagnostics', async () => {
        const restoreConfig = stubOtakProxyConfiguration();
        const calls: Array<{ command: string; args: string[] }> = [];
        const runner: CommandRunner = async (command, args) => {
            calls.push({ command, args });
            await new Promise(resolve => setTimeout(resolve, 10));

            if (args.includes('--json')) {
                return {
                    stdout: JSON.stringify({
                        proxy: 'http://proxy.example.com:8080',
                        'https-proxy': 'http://proxy.example.com:8080',
                        noproxy: ['localhost', '127.0.0.1'],
                        registry: 'https://registry.npmjs.org/'
                    }),
                    stderr: ''
                };
            }

            return { stdout: '', stderr: '' };
        };
        const diagnostics = new ProxyRuntimeDiagnostics(
            createContext(),
            async () => ({ mode: ProxyMode.Off } as ProxyState),
            { commandRunner: runner }
        );

        try {
            const reports = await Promise.all([
                diagnostics.run({ bypassSlowCache: true }),
                diagnostics.run({ bypassSlowCache: true })
            ]);

            const npmCalls = calls.filter(call =>
                call.command.toLowerCase().endsWith('npm') || call.args.includes('npm')
            );
            assert.strictEqual(npmCalls.length, 1);
            assert.deepStrictEqual(reports[0].observations.npm, {
                proxy: 'http://proxy.example.com:8080',
                httpsProxy: 'http://proxy.example.com:8080',
                noproxy: 'localhost,127.0.0.1',
                registry: 'https://registry.npmjs.org/'
            });
            assert.deepStrictEqual(reports[1].observations.npm, reports[0].observations.npm);
        } finally {
            restoreConfig();
        }
    });
});
