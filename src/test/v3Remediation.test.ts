import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import { ProxyApplyDetailedResult } from '../core/ProxyApplierTypes';
import { ProxyMode } from '../core/types';
import { ProxyIssue } from '../core/v3Types';
import { ProxyDiagnosticReport, ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { ApplyLockRequest, ApplyLockService } from '../remediation/ApplyLockService';
import { FlapTracker, FlapTrackerSettings } from '../remediation/FlapTracker';
import { ProxyRemediationService } from '../remediation/ProxyRemediationService';

type Store = Map<string, unknown>;

function createMemento(store: Store): vscode.Memento & { setKeysForSync(keys: readonly string[]): void } {
    return {
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
    };
}

function createContext(store: Store): vscode.ExtensionContext {
    return {
        globalState: createMemento(store),
        workspaceState: createMemento(new Map()),
        subscriptions: [],
        extensionPath: '',
        storagePath: undefined,
        globalStoragePath: '',
        logPath: '',
        extensionUri: vscode.Uri.file(''),
        storageUri: undefined,
        globalStorageUri: vscode.Uri.file(''),
        logUri: vscode.Uri.file(''),
        asAbsolutePath: (relativePath: string) => relativePath,
        environmentVariableCollection: new Map() as unknown as vscode.GlobalEnvironmentVariableCollection,
        extensionMode: vscode.ExtensionMode.Test,
        secrets: {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: () => ({ dispose: () => {} })
        } as unknown as vscode.SecretStorage,
        extension: {
            extensionKind: vscode.ExtensionKind.Workspace,
            packageJSON: { version: 'test' }
        } as unknown as vscode.Extension<unknown>,
        languageModelAccessInformation: {} as unknown
    } as unknown as vscode.ExtensionContext;
}

function stubOtakProxyConfiguration(overrides: Record<string, unknown>): () => void {
    const original = vscode.workspace.getConfiguration;
    (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration =
        ((section?: string) => {
            if (section === 'otakProxy') {
                return {
                    get: (key: string, defaultValue?: unknown) => key in overrides ? overrides[key] : defaultValue,
                    update: async () => {},
                    inspect: () => undefined,
                    has: () => true
                } as unknown as vscode.WorkspaceConfiguration;
            }
            return original(section);
        }) as typeof vscode.workspace.getConfiguration;
    return () => {
        (vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }).getConfiguration = original;
    };
}

function detailedResult(
    success: boolean,
    errors: ProxyApplyDetailedResult['errors'] = [],
    enabled = true
): ProxyApplyDetailedResult {
    return {
        success,
        enabled,
        proxyUrl: enabled ? 'http://proxy.example.com:8080' : '',
        results: {
            gitSuccess: success,
            vscodeSuccess: success,
            npmSuccess: success,
            terminalEnvSuccess: success
        },
        errors
    };
}

function diagnosticReport(issues: ProxyIssue[] = []): ProxyDiagnosticReport {
    return {
        generatedAt: new Date(0).toISOString(),
        runtimeState: 'diagnosed',
        executionContext: {
            uiKind: 'desktop',
            extensionHostLocation: 'localUi',
            workspaceHostKind: 'localWindows',
            canUseChildProcess: true,
            canReadWindowsRegistry: true,
            canWriteVSCodeUserSettings: true,
            canAccessWorkspaceFiles: false
        },
        issueCount: issues.length,
        highestPriorityCategory: issues[0]?.category,
        issues,
        observations: {}
    };
}

function managedConvergenceIssue(id: string, targetId: string): ProxyIssue {
    return {
        id,
        fingerprint: `${id}:${targetId}`,
        category: 'applyFailed',
        impact: 'blocksConvergence',
        targetId,
        targetHost: 'workspaceHost',
        expectedSanitized: 'unset',
        actualSanitized: 'http://stale.example.com:8080',
        source: 'diagnostics',
        capability: 'readOnly',
        autoAction: 'none',
        userAction: 'showDetails',
        evidence: {}
    };
}

suite('v3 remediation foundation', () => {
    const flapSettings: FlapTrackerSettings = {
        windowMs: 1000,
        maxAttempts: 2,
        cooldownMs: 5000,
        notificationCooldownMs: 1000
    };

    test('ApplyLockService blocks concurrent writers and takes over stale locks', async () => {
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-test-'));
        let now = 1000;
        const service = new ApplyLockService({ baseDir, now: () => now });
        const target: ApplyLockRequest = {
            targetId: 'git.global.http.proxy',
            targetHost: 'workspaceHost',
            scope: 'hostUser'
        };

        try {
            const first = await service.tryAcquire(target, 100);
            assert.ok(first.acquired && first.handle);

            const second = await service.tryAcquire(target, 100);
            assert.strictEqual(second.acquired, false);
            assert.strictEqual(second.reason, 'held');

            now = 1200;
            const staleTakeover = await service.tryAcquire(target, 100);
            assert.ok(staleTakeover.acquired && staleTakeover.handle);

            await service.release(staleTakeover.handle);
        } finally {
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('FlapTracker escalates repeated non-convergence and suppresses further attempts during cooldown', async () => {
        const store = new Map<string, unknown>();
        let now = 1000;
        const tracker = new FlapTracker(createMemento(store), () => now);
        const fingerprint = 'same-issue';

        assert.strictEqual((await tracker.recordAttempt(fingerprint, flapSettings)).allowed, true);
        assert.strictEqual((await tracker.recordNonConvergence(fingerprint, 'externalOverride', flapSettings)).escalated, false);

        now = 1100;
        assert.strictEqual((await tracker.recordAttempt(fingerprint, flapSettings)).allowed, true);
        const convergence = await tracker.recordNonConvergence(fingerprint, 'externalOverride', flapSettings);
        assert.strictEqual(convergence.escalated, true);
        assert.ok(convergence.cooldownUntil && convergence.cooldownUntil > now);

        now = 1200;
        const suppressed = await tracker.recordAttempt(fingerprint, flapSettings);
        assert.strictEqual(suppressed.allowed, false);
        assert.strictEqual(suppressed.cooldownUntil, convergence.cooldownUntil);
    });

    test('ProxyRemediationService retries one eligible manual failure and records diagnostics', async () => {
        const restoreConfig = stubOtakProxyConfiguration({
            notificationLevel: 'off',
            credentialTargetPolicy: 'allowPlaintextTargets',
            remediationDelayedRetryMs: 250
        });
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-remediation-test-'));
        const context = createContext(new Map());
        const calls: string[] = [];
        const diagnostics = {
            run: async () => diagnosticReport()
        } as unknown as ProxyRuntimeDiagnostics;
        const service = new ProxyRemediationService(
            context,
            async () => ({ mode: ProxyMode.Manual, manualProxyUrl: 'http://alice:s3cr3t@proxy.example.com:8080' }),
            {
                lockService: new ApplyLockService({ baseDir }),
                diagnostics,
                sleep: async () => {}
            }
        );

        try {
            const result = await service.applyWithSafety(
                'http://alice:s3cr3t@proxy.example.com:8080',
                true,
                { trigger: 'manual' },
                async (url) => {
                    calls.push(url);
                    return calls.length === 1
                        ? detailedResult(false, [{ target: 'npm configuration', message: 'timeout' }])
                        : detailedResult(true);
                }
            );

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.retryAttempted, true);
            assert.strictEqual(result.retrySuppressed, false);
            assert.strictEqual(result.diagnosticReport?.issueCount, 0);
            assert.deepStrictEqual(calls, [
                'http://alice:s3cr3t@proxy.example.com:8080',
                'http://alice:s3cr3t@proxy.example.com:8080'
            ]);
        } finally {
            restoreConfig();
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('ProxyRemediationService retries successful OFF writes when diagnostics still sees managed proxy', async () => {
        const restoreConfig = stubOtakProxyConfiguration({
            notificationLevel: 'off',
            credentialTargetPolicy: 'allowPlaintextTargets',
            remediationDelayedRetryMs: 250
        });
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-off-convergence-test-'));
        const context = createContext(new Map());
        const calls: Array<{ enabled: boolean; silent?: boolean }> = [];
        const diagnosticOptions: unknown[] = [];
        const reports = [
            diagnosticReport([managedConvergenceIssue('npm.managedProxyResidual', 'npm.user.proxy')]),
            diagnosticReport()
        ];
        const diagnostics = {
            run: async (options?: unknown) => {
                diagnosticOptions.push(options);
                return reports.shift() ?? diagnosticReport();
            }
        } as unknown as ProxyRuntimeDiagnostics;
        const service = new ProxyRemediationService(
            context,
            async () => ({ mode: ProxyMode.Auto, autoModeOff: true, npmConfigured: false }),
            {
                lockService: new ApplyLockService({ baseDir }),
                diagnostics,
                sleep: async () => {}
            }
        );

        try {
            const result = await service.applyWithSafety(
                '',
                false,
                { trigger: 'manual' },
                async (_url, enabled, options) => {
                    calls.push({ enabled, silent: options?.silent });
                    return detailedResult(true, [], enabled);
                }
            );

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.retryAttempted, true);
            assert.strictEqual(result.retrySuppressed, false);
            assert.deepStrictEqual(calls, [
                { enabled: false, silent: undefined },
                { enabled: false, silent: true }
            ]);
            assert.ok(diagnosticOptions.every(option =>
                typeof option === 'object' &&
                option !== null &&
                (option as { bypassSlowCache?: boolean }).bypassSlowCache === true
            ));
        } finally {
            restoreConfig();
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('ProxyRemediationService retries successful ON writes when diagnostics sees a managed proxy mismatch', async () => {
        const restoreConfig = stubOtakProxyConfiguration({
            notificationLevel: 'off',
            credentialTargetPolicy: 'allowPlaintextTargets',
            remediationDelayedRetryMs: 250
        });
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-on-convergence-test-'));
        const context = createContext(new Map());
        const calls: Array<{ url: string; enabled: boolean; silent?: boolean }> = [];
        const reports = [
            diagnosticReport([managedConvergenceIssue('git.managedProxyMismatch', 'git.global.proxy')]),
            diagnosticReport()
        ];
        const diagnostics = {
            run: async () => reports.shift() ?? diagnosticReport()
        } as unknown as ProxyRuntimeDiagnostics;
        const service = new ProxyRemediationService(
            context,
            async () => ({
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080',
                gitConfigured: true
            }),
            {
                lockService: new ApplyLockService({ baseDir }),
                diagnostics,
                sleep: async () => {}
            }
        );

        try {
            const result = await service.applyWithSafety(
                'http://proxy.example.com:8080',
                true,
                { trigger: 'manual' },
                async (url, enabled, options) => {
                    calls.push({ url, enabled, silent: options?.silent });
                    return detailedResult(true, [], enabled);
                }
            );

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.retryAttempted, true);
            assert.strictEqual(result.retrySuppressed, false);
            assert.deepStrictEqual(calls, [
                { url: 'http://proxy.example.com:8080', enabled: true, silent: undefined },
                { url: 'http://proxy.example.com:8080', enabled: true, silent: true }
            ]);
        } finally {
            restoreConfig();
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('ProxyRemediationService does not retry sync-applied failures', async () => {
        const restoreConfig = stubOtakProxyConfiguration({ notificationLevel: 'off' });
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-sync-test-'));
        const context = createContext(new Map());
        let calls = 0;
        const service = new ProxyRemediationService(
            context,
            async () => ({ mode: ProxyMode.Manual }),
            {
                lockService: new ApplyLockService({ baseDir }),
                diagnostics: { run: async () => diagnosticReport() } as unknown as ProxyRuntimeDiagnostics,
                sleep: async () => {}
            }
        );

        try {
            const result = await service.applyWithSafety(
                'http://proxy.example.com:8080',
                true,
                { trigger: 'sync', silent: true },
                async () => {
                    calls += 1;
                    return detailedResult(false, [{ target: 'Git configuration', message: 'locked' }]);
                }
            );

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.retryAttempted, false);
            assert.strictEqual(calls, 1);
        } finally {
            restoreConfig();
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('ProxyRemediationService blocks credential-bearing target writes when policy forbids plaintext targets', async () => {
        const restoreConfig = stubOtakProxyConfiguration({
            notificationLevel: 'off',
            credentialTargetPolicy: 'blockPlaintextTargets'
        });
        const context = createContext(new Map());
        let calls = 0;
        const service = new ProxyRemediationService(
            context,
            async () => ({ mode: ProxyMode.Manual }),
            {
                diagnostics: { run: async () => diagnosticReport() } as unknown as ProxyRuntimeDiagnostics
            }
        );

        try {
            const result = await service.applyWithSafety(
                'http://alice:s3cr3t@proxy.example.com:8080',
                true,
                { trigger: 'manual' },
                async () => {
                    calls += 1;
                    return detailedResult(true);
                }
            );

            assert.strictEqual(result.success, false);
            assert.strictEqual(calls, 0);
            assert.strictEqual(result.retryAttempted, false);
        } finally {
            restoreConfig();
        }
    });

    test('ProxyRemediationService skips writes when another window holds a host-user lock', async () => {
        const restoreConfig = stubOtakProxyConfiguration({ notificationLevel: 'off' });
        const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-skip-test-'));
        const context = createContext(new Map());
        const lockService = new ApplyLockService({ baseDir });
        const held = await lockService.tryAcquire({
            targetId: 'git.global.http.proxy',
            targetHost: 'workspaceHost',
            scope: 'hostUser'
        }, 30000);
        assert.ok(held.acquired && held.handle);

        let calls = 0;
        const service = new ProxyRemediationService(
            context,
            async () => ({ mode: ProxyMode.Manual }),
            {
                lockService,
                diagnostics: { run: async () => diagnosticReport() } as unknown as ProxyRuntimeDiagnostics
            }
        );

        try {
            const result = await service.applyWithSafety(
                'http://proxy.example.com:8080',
                true,
                { trigger: 'manual' },
                async () => {
                    calls += 1;
                    return detailedResult(true);
                }
            );

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.lockSkipped, true);
            assert.strictEqual(calls, 0);
        } finally {
            await lockService.release(held.handle);
            restoreConfig();
            await fs.rm(baseDir, { recursive: true, force: true });
        }
    });

    test('TerminalEnvConfigManager supports Windows-style uppercase env and Off masking', async () => {
        const replaced: Record<string, string> = {};
        const deleted: string[] = [];
        const manager = new TerminalEnvConfigManager({
            replace: (key: string, value: string) => {
                replaced[key] = value;
            },
            delete: (key: string) => {
                deleted.push(key);
            }
        }, {
            includeLowercase: false,
            noProxy: 'localhost,127.0.0.1',
            maskOnUnset: true
        });

        await manager.setProxy('http://proxy.example.com:8080');
        assert.strictEqual(replaced.HTTP_PROXY, 'http://proxy.example.com:8080');
        assert.strictEqual(replaced.HTTPS_PROXY, 'http://proxy.example.com:8080');
        assert.strictEqual(replaced.NO_PROXY, 'localhost,127.0.0.1');
        assert.strictEqual(replaced.http_proxy, undefined);

        await manager.unsetProxy();
        assert.strictEqual(replaced.HTTP_PROXY, '');
        assert.strictEqual(replaced.HTTPS_PROXY, '');
        assert.strictEqual(replaced.ALL_PROXY, '');
        assert.strictEqual(replaced.NO_PROXY, '');
        assert.deepStrictEqual(deleted, []);
    });
});
