import * as assert from 'assert';
import * as http from 'http';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeToggleProxy } from '../../commands/ToggleProxyCommand';
import { CommandContext } from '../../commands/types';
import { ProxyMode, ProxyState } from '../../core/types';

suite('ToggleProxyCommand Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) => key === 'enableFallback' ? true : defaultValue,
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as vscode.WorkspaceConfiguration);
    });

    teardown(() => {
        sandbox.restore();
    });

    async function listen(server: http.Server): Promise<number> {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                const address = server.address();
                if (typeof address === 'object' && address !== null) {
                    resolve(address.port);
                    return;
                }
                reject(new Error('Unable to determine test proxy port'));
            });
        });
    }

    async function close(server: http.Server): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }

    function createContext(
        initialState: ProxyState,
        checkAndUpdateSystemProxy: () => Promise<void>
    ): { ctx: CommandContext; getState: () => ProxyState; applyCalls: Array<{ url: string; enabled: boolean }> } {
        let state = { ...initialState };
        const applyCalls: Array<{ url: string; enabled: boolean }> = [];

        const ctx: CommandContext = {
            extensionContext: {} as vscode.ExtensionContext,
            getProxyState: async () => state,
            saveProxyState: async (nextState) => {
                state = { ...nextState };
            },
            getActiveProxyUrl: (proxyState) => {
                if (proxyState.mode === ProxyMode.Auto) {
                    return proxyState.autoProxyUrl || '';
                }
                if (proxyState.mode === ProxyMode.Manual) {
                    return proxyState.manualProxyUrl || '';
                }
                return '';
            },
            getNextMode: (mode) => mode === ProxyMode.Manual ? ProxyMode.Auto : ProxyMode.Off,
            applyProxySettings: async (url, enabled) => {
                applyCalls.push({ url, enabled });
                return true;
            },
            updateStatusBar: () => {},
            checkAndUpdateSystemProxy,
            startSystemProxyMonitoring: async () => {},
            stopSystemProxyMonitoring: async () => {},
            userNotifier: {
                showSuccess: () => {},
                showWarning: () => {},
                showError: () => {},
                showErrorWithDetails: async () => {},
                showProgressNotification: async (_title, task) => task({ report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>)
            },
            sanitizer: {
                maskPassword: (url) => url.replace(/:([^:@/]+)@/, ':***@')
            }
        };

        return { ctx, getState: () => state, applyCalls };
    }

    test('should keep detected auto proxy when switching from Manual to Auto', async () => {
        let setDetectedProxy: (() => void) | undefined;
        const { ctx, getState, applyCalls } = createContext(
            {
                mode: ProxyMode.Manual,
                manualProxyUrl: 'http://manual.example.com:8080'
            },
            async () => setDetectedProxy?.()
        );
        setDetectedProxy = () => {
            const state = getState();
            state.autoProxyUrl = 'http://system.example.com:8080';
            state.systemProxyDetected = true;
            state.lastSystemProxyCheck = 123;
        };

        const result = await executeToggleProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://system.example.com:8080');
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
            url: 'http://system.example.com:8080',
            enabled: true
        });
    });

    test('should not use unreachable manual proxy as Auto fallback', async function() {
        this.timeout(5000);
        const server = http.createServer();
        server.on('connect', (_request, socket) => {
            socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            socket.destroy();
        });

        const port = await listen(server);
        try {
            const { ctx, getState, applyCalls } = createContext(
                {
                    mode: ProxyMode.Manual,
                    manualProxyUrl: `http://127.0.0.1:${port}`
                },
                async () => {}
            );

            const result = await executeToggleProxy(ctx);
            const state = getState();

            assert.strictEqual(result.success, true);
            assert.strictEqual(state.mode, ProxyMode.Auto);
            assert.strictEqual(state.autoProxyUrl, undefined);
            assert.strictEqual(state.autoModeOff, true);
            assert.strictEqual(state.usingFallbackProxy, false);
            assert.strictEqual(state.lastTestResult?.success, false);
            assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
                url: '',
                enabled: false
            });
        } finally {
            await close(server);
        }
    });
});
