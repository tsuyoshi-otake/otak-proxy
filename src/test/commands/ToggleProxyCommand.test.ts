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
        checkAndUpdateSystemProxy: () => Promise<void>,
        applyProxySettings?: (url: string, enabled: boolean) => Promise<boolean>
    ): {
        ctx: CommandContext;
        getState: () => ProxyState;
        applyCalls: Array<{ url: string; enabled: boolean }>;
        monitorCalls: string[];
    } {
        let state = { ...initialState };
        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const monitorCalls: string[] = [];

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
            getNextMode: (mode) => mode === ProxyMode.Auto ? ProxyMode.Off : ProxyMode.Auto,
            applyProxySettings: async (url, enabled) => {
                applyCalls.push({ url, enabled });
                if (applyProxySettings) {
                    return applyProxySettings(url, enabled);
                }
                return true;
            },
            updateStatusBar: () => {},
            checkAndUpdateSystemProxy,
            startSystemProxyMonitoring: async () => { monitorCalls.push('start'); },
            stopSystemProxyMonitoring: async () => { monitorCalls.push('stop'); },
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

        return { ctx, getState: () => state, applyCalls, monitorCalls };
    }

    test('should switch from Off to Auto when an auto proxy is detected', async () => {
        let setDetectedProxy: (() => void) | undefined;
        const { ctx, getState, applyCalls, monitorCalls } = createContext(
            { mode: ProxyMode.Off },
            async () => setDetectedProxy?.()
        );
        setDetectedProxy = () => {
            const state = getState();
            state.autoProxyUrl = 'http://system.example.com:8080';
            state.systemProxyDetected = true;
        };

        const result = await executeToggleProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
            url: 'http://system.example.com:8080',
            enabled: true
        });
        assert.deepStrictEqual(monitorCalls, ['start']);
    });

    test('should switch from Auto to Off', async () => {
        const { ctx, getState, applyCalls, monitorCalls } = createContext(
            {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://system.example.com:8080'
            },
            async () => {}
        );

        const result = await executeToggleProxy(ctx);
        const state = getState();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
            url: '',
            enabled: false
        });
        assert.deepStrictEqual(monitorCalls, ['stop']);
    });

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

    test('should serialize rapid toggles and apply each transition in order', async () => {
        let setDetectedProxy: (() => void) | undefined;
        let activeApplyCount = 0;
        let maxActiveApplyCount = 0;

        const { ctx, getState, applyCalls, monitorCalls } = createContext(
            { mode: ProxyMode.Off },
            async () => setDetectedProxy?.(),
            async () => {
                activeApplyCount++;
                maxActiveApplyCount = Math.max(maxActiveApplyCount, activeApplyCount);
                await new Promise<void>(resolve => setTimeout(resolve, 20));
                activeApplyCount--;
                return true;
            }
        );
        setDetectedProxy = () => {
            const state = getState();
            state.autoProxyUrl = 'http://system.example.com:8080';
            state.systemProxyDetected = true;
        };

        const [firstResult, secondResult] = await Promise.all([
            executeToggleProxy(ctx),
            executeToggleProxy(ctx)
        ]);
        const state = getState();

        assert.strictEqual(firstResult.success, true);
        assert.strictEqual(secondResult.success, true);
        assert.strictEqual(maxActiveApplyCount, 1);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls, [
            { url: 'http://system.example.com:8080', enabled: true },
            { url: '', enabled: false }
        ]);
        assert.deepStrictEqual(monitorCalls, ['start', 'stop']);
    });
});
