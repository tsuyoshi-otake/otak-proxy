import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeToggleProxy } from '../../commands/ToggleProxyCommand';
import { CommandContext } from '../../commands/types';
import { ProxyMode, ProxyState, SystemProxyCheckOutcome } from '../../core/types';
import { ProxyRuntimeDiagnostics } from '../../diagnostics/ProxyRuntimeDiagnostics';
import { I18nManager } from '../../i18n/I18nManager';
import { ApplyLockService } from '../../remediation/ApplyLockService';
import { runProxyApplyAttempt } from '../../remediation/ProxyApplyAttempt';
import { ProxyRemediationService } from '../../remediation/ProxyRemediationService';

suite('ToggleProxyCommand Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let showWarningMessageStub: sinon.SinonStub;
    let executeCommandStub: sinon.SinonStub;
    const i18n = I18nManager.getInstance();

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n.initialize('en');
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
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
        checkAndUpdateSystemProxy: () => Promise<SystemProxyCheckOutcome | void>,
        applyProxySettings?: (url: string, enabled: boolean) => Promise<boolean>
    ): {
        ctx: CommandContext;
        getState: () => ProxyState;
        applyCalls: Array<{ url: string; enabled: boolean }>;
        monitorCalls: string[];
        statusBarStates: ProxyState[];
    } {
        let state = { ...initialState };
        const applyCalls: Array<{ url: string; enabled: boolean }> = [];
        const monitorCalls: string[] = [];
        const statusBarStates: ProxyState[] = [];

        const ctx: CommandContext = {
            extensionContext: {} as vscode.ExtensionContext,
            // Real ProxyStateManager returns a fresh persisted object; returning
            // the same reference would let the command's mutations silently pass
            // as committed state (#78 stub fidelity).
            getProxyState: async () => ({ ...state }),
            saveProxyState: async (nextState) => {
                state = { ...nextState };
            },
            commitProxyState: async (expectedRevision, next) => {
                if ((state.revision ?? 0) !== expectedRevision) {
                    return { kind: 'superseded' as const, current: { ...state } };
                }
                state = { ...next, revision: expectedRevision + 1 };
                return { kind: 'committed' as const, revision: expectedRevision + 1, state: { ...state } };
            },
            publishProxyState: async () => {},
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
            updateStatusBar: (next) => {
                statusBarStates.push({ ...next });
            },
            checkAndUpdateSystemProxy: async () => (await checkAndUpdateSystemProxy()) ?? 'completed',
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

        return { ctx, getState: () => state, applyCalls, monitorCalls, statusBarStates };
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

    test('Off to Auto when detection fails: the mode stays Off, nothing is written, no fallback or no-proxy prompt (#108)', async () => {
        // With a manual URL and enableFallback on, treating "unknown" as "no
        // proxy" would test and engage the fallback or turn Auto OFF.
        const initial: ProxyState = { mode: ProxyMode.Off, manualProxyUrl: 'http://127.0.0.1:9' };
        const { ctx, getState, applyCalls, monitorCalls } = createContext(
            initial,
            async () => 'detectionFailed'
        );

        const result = await executeToggleProxy(ctx);

        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(getState(), initial, 'nothing is committed');
        assert.deepStrictEqual(applyCalls, []);
        assert.deepStrictEqual(monitorCalls, []);
        sinon.assert.calledOnceWithExactly(showWarningMessageStub, i18n.t('warning.detectionFailed'));
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

    test('should use a 407 manual proxy as Auto fallback instead of treating it as broken', async function() {
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
            assert.strictEqual(state.autoProxyUrl, `http://127.0.0.1:${port}`);
            assert.strictEqual(state.autoModeOff, false);
            assert.strictEqual(state.usingFallbackProxy, true);
            assert.strictEqual(state.lastTestResult?.success, false);
            assert.strictEqual(state.lastTestResult?.failureKind, 'authRequired');
            assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
                url: `http://127.0.0.1:${port}`,
                enabled: true
            });
        } finally {
            await close(server);
        }
    });

    test('should not use unreachable manual proxy as Auto fallback', async function() {
        this.timeout(5000);
        const server = http.createServer();
        const port = await listen(server);
        await close(server);

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
        assert.strictEqual(state.lastTestResult?.failureKind, 'endpointUnreachable');
        assert.deepStrictEqual(applyCalls[applyCalls.length - 1], {
            url: '',
            enabled: false
        });
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

    test('should move to Auto OFF and release the queue even while the system-proxy warning is unanswered', async () => {
        let resolveWarning!: (value: string | undefined) => void;
        showWarningMessageStub.returns(new Promise<string | undefined>(resolve => {
            resolveWarning = resolve;
        }));

        const { ctx, getState } = createContext(
            { mode: ProxyMode.Off },
            async () => {}
        );

        const first = await executeToggleProxy(ctx);
        assert.strictEqual(first.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Auto);
        assert.strictEqual(getState().autoModeOff, true);

        // The warning from the first toggle is still pending (unanswered).
        // A second toggle must still complete instead of queuing behind it.
        const second = await executeToggleProxy(ctx);
        assert.strictEqual(second.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Off);

        resolveWarning(undefined);
    });

    test('should run configureUrl when Configure Manual is chosen on the system-proxy warning', async () => {
        showWarningMessageStub.resolves(i18n.t('action.configureManual'));

        const { ctx, getState } = createContext({ mode: ProxyMode.Off }, async () => {});
        const result = await executeToggleProxy(ctx);

        assert.strictEqual(result.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Auto);
        assert.strictEqual(getState().autoModeOff, true);

        // The follow-up prompt is fire-and-forget; let its microtask chain settle.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        sinon.assert.calledWith(executeCommandStub, 'otak-proxy.configureUrl');
    });

    test('should run importProxy when Import System is chosen on the system-proxy warning', async () => {
        showWarningMessageStub.resolves(i18n.t('action.importSystem'));

        const { ctx } = createContext({ mode: ProxyMode.Off }, async () => {});
        await executeToggleProxy(ctx);

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        sinon.assert.calledWith(executeCommandStub, 'otak-proxy.importProxy');
    });

    test('should move to Auto OFF when the system-proxy warning is dismissed without an answer', async () => {
        showWarningMessageStub.resolves(undefined);

        const { ctx, getState, applyCalls } = createContext({ mode: ProxyMode.Off }, async () => {});
        const result = await executeToggleProxy(ctx);

        assert.strictEqual(result.success, true);
        assert.strictEqual(getState().mode, ProxyMode.Auto);
        assert.strictEqual(getState().autoModeOff, true);
        assert.deepStrictEqual(applyCalls[applyCalls.length - 1], { url: '', enabled: false });
    });

    test('should return failure when the prepared state cannot converge', async () => {
        const { ctx, getState, applyCalls, monitorCalls } = createContext(
            { mode: ProxyMode.Auto, autoProxyUrl: 'http://system.example.com:8080' },
            async () => {},
            async () => false
        );

        const result = await executeToggleProxy(ctx);

        assert.strictEqual(result.success, false);
        assert.strictEqual(getState().mode, ProxyMode.Off);
        assert.deepStrictEqual(applyCalls, [{ url: '', enabled: false }]);
        assert.deepStrictEqual(monitorCalls, ['stop']);
    });

    test('should not stack duplicate system-proxy warnings while one is unanswered', async () => {
        let resolveWarning!: (value: string | undefined) => void;
        showWarningMessageStub.returns(new Promise<string | undefined>(resolve => {
            resolveWarning = resolve;
        }));

        const { ctx } = createContext({ mode: ProxyMode.Off }, async () => {});

        await executeToggleProxy(ctx); // Off -> Auto attempt -> warning fired (pending)
        await executeToggleProxy(ctx); // Auto -> Off
        await executeToggleProxy(ctx); // Off -> Auto attempt again -> warning still pending, must not stack

        assert.strictEqual(showWarningMessageStub.callCount, 1);

        resolveWarning(undefined);
    });

    test('does not paint successful Auto from the pre-apply snapshot when apply is blocked', async () => {
        let fixture: ReturnType<typeof createContext>;
        fixture = createContext(
            { mode: ProxyMode.Off, autoProxyUrl: 'http://system.example.com:8080' },
            async () => {},
            async () => {
                const current = fixture.getState();
                current.lastError = 'Proxy settings were not changed because the workspace is untrusted.';
                current.applyBlocked = 'untrustedWorkspace';
                current.targetOutcomes = { git: 'failed', vscode: 'failed', npm: 'failed', terminalEnv: 'failed' };
                return false;
            }
        );

        const result = await executeToggleProxy(fixture.ctx);
        const painted = fixture.statusBarStates.at(-1);

        assert.strictEqual(result.success, false);
        assert.strictEqual(fixture.getState().mode, ProxyMode.Auto);
        assert.ok(painted, 'toggle must refresh the status bar after apply');
        assert.strictEqual(painted?.applyBlocked, 'untrustedWorkspace');
        assert.ok(painted?.lastError?.toLowerCase().includes('untrusted'));
    });

    /**
     * #108 P3: a toggle whose apply dies inside the real ApplyLockService ->
     * ProxyRemediationService path. The lock's baseDir is a regular file, so
     * the real directory check reports notDirectory -> ioError and the apply
     * stops before any writer. Seam: `ctx.applyProxySettings` is wired to
     * `runProxyApplyAttempt` exactly like extension.ts's applyProxySafely;
     * the writers sit behind the `applyDetailed` delegate, which the lock
     * must never reach.
     */
    test('a lock-directory ioError through the real remediation path fails the toggle without toggleFailed (#108)', async () => {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-toggle-lock-'));
        const lockDirFile = path.join(workDir, 'not-a-dir');
        fs.writeFileSync(lockDirFile, 'x');
        try {
            const store = new Map<string, unknown>();
            const extensionContext = {
                globalState: {
                    get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
                    update: async (key: string, value: unknown) => {
                        if (value === undefined) {
                            store.delete(key);
                        } else {
                            store.set(key, value);
                        }
                    },
                    keys: () => [...store.keys()],
                    setKeysForSync: () => {}
                }
            } as unknown as vscode.ExtensionContext;
            const remediation = new ProxyRemediationService(
                extensionContext,
                async () => fixture.getState(),
                {
                    lockService: new ApplyLockService({ baseDir: lockDirFile }),
                    diagnostics: { run: async () => undefined } as unknown as ProxyRuntimeDiagnostics,
                    sleep: async () => {}
                }
            );
            let writerCalls = 0;
            const fixture = createContext(
                { mode: ProxyMode.Auto, autoProxyUrl: 'http://system.example.com:8080' },
                async () => {},
                async (url, enabled) => (await runProxyApplyAttempt(
                    {
                        getState: async () => fixture.getState(),
                        saveState: next => fixture.ctx.saveProxyState(next),
                        commitState: (revision, next) => fixture.ctx.commitProxyState(revision, next)
                    },
                    async (proxyUrl, applyEnabled) => {
                        writerCalls += 1;
                        return {
                            success: true,
                            enabled: applyEnabled,
                            proxyUrl,
                            results: {
                                gitSuccess: true,
                                vscodeSuccess: true,
                                npmSuccess: true,
                                terminalEnvSuccess: true
                            },
                            errors: []
                        };
                    },
                    remediation,
                    url,
                    enabled,
                    'manual'
                )).success
            );
            const errorKeys: string[] = [];
            fixture.ctx.userNotifier.showError = (key) => {
                errorKeys.push(key);
            };
            const unhandledRejections: unknown[] = [];
            const onUnhandledRejection = (reason: unknown) => {
                unhandledRejections.push(reason);
            };
            process.on('unhandledRejection', onUnhandledRejection);

            let result: Awaited<ReturnType<typeof executeToggleProxy>>;
            try {
                result = await executeToggleProxy(fixture.ctx);
                // The applyFailed notification is fire-and-forget; let it settle.
                await new Promise(resolve => setTimeout(resolve, 20));
            } finally {
                process.removeListener('unhandledRejection', onUnhandledRejection);
            }

            const i18n = I18nManager.getInstance();
            assert.strictEqual(result.success, false);
            sinon.assert.calledOnceWithExactly(
                showWarningMessageStub,
                i18n.t('remediation.notification.applyFailed'),
                i18n.t('action.showDetails')
            );
            assert.deepStrictEqual(errorKeys, [], 'error.toggleFailed must not fire for a lock ioError');
            assert.strictEqual(writerCalls, 0, 'the lock stops the apply before any writer runs');
            assert.deepStrictEqual(unhandledRejections, [], 'no unhandled rejection may escape the apply path');
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    });
});
