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
                call.command.toLowerCase().endsWith('npm') ||
                call.command.toLowerCase().endsWith('npm.cmd') ||
                call.command.toLowerCase().endsWith('npm-cli.js') ||
                call.args.includes('npm') ||
                call.args.some(arg => /(?:^|[/\\])npm-cli\.js$/i.test(arg))
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

    test('terminal observation reports ownedVars and maskedVars without treating empty NO_PROXY as no proxy', async () => {
        const restoreConfig = stubOtakProxyConfiguration();
        const collection = new Map<string, { type: number; value: string; options: object }>([
            ['HTTP_PROXY', { type: 1, value: '', options: {} }],
            ['HTTPS_PROXY', { type: 1, value: '', options: {} }],
            ['NO_PROXY', { type: 1, value: '', options: {} }]
        ]);
        Object.assign(collection, {
            persistent: true,
            description: 'Managed by otak-proxy for newly created terminals.'
        });
        const diagnostics = new ProxyRuntimeDiagnostics(
            {
                extension: { extensionKind: vscode.ExtensionKind.Workspace },
                environmentVariableCollection: collection
            } as unknown as vscode.ExtensionContext,
            async () => ({ mode: ProxyMode.Off } as ProxyState),
            { commandRunner: async () => ({ stdout: '', stderr: '' }) }
        );

        try {
            const report = await diagnostics.run({ bypassSlowCache: true });
            const terminal = report.observations.terminal as {
                ownedVars: string[];
                maskedVars: string[];
                mutators: Record<string, { value: string }>;
            };
            assert.deepStrictEqual(terminal.ownedVars, ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
            assert.deepStrictEqual(terminal.maskedVars, ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
            assert.strictEqual(terminal.mutators.NO_PROXY.value, '');
            assert.ok(!('noProxyConfigured' in terminal));
        } finally {
            restoreConfig();
        }
    });
});
