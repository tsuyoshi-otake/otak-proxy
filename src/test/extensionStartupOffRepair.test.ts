import * as assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';

const execFileAsync = promisify(execFile);

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

function createEnvCollection(): vscode.GlobalEnvironmentVariableCollection {
    const collection = new Map<string, unknown>() as Map<string, unknown> & {
        replace(name: string, value: string, options?: unknown): void;
        delete(name: string): boolean;
        persistent: boolean;
        description: string;
    };
    collection.replace = (name: string, value: string, options?: unknown) => {
        collection.set(name, { type: 1, value, options });
    };
    collection.persistent = true;
    collection.description = '';
    return collection as unknown as vscode.GlobalEnvironmentVariableCollection;
}

function createContext(baseDir: string, globalState: Store): vscode.ExtensionContext {
    const memento = createMemento(globalState);
    const secrets = new Map<string, string>();
    return {
        globalState: memento,
        workspaceState: createMemento(new Map()),
        subscriptions: [],
        extensionPath: baseDir,
        storagePath: baseDir,
        globalStoragePath: baseDir,
        logPath: baseDir,
        extensionUri: vscode.Uri.file(baseDir),
        storageUri: vscode.Uri.file(baseDir),
        globalStorageUri: vscode.Uri.file(baseDir),
        logUri: vscode.Uri.file(baseDir),
        asAbsolutePath: (relativePath: string) => path.join(baseDir, relativePath),
        environmentVariableCollection: createEnvCollection(),
        extensionMode: vscode.ExtensionMode.Test,
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        } as unknown as vscode.SecretStorage,
        extension: {
            extensionKind: vscode.ExtensionKind.Workspace,
            packageJSON: { version: 'test' }
        } as unknown as vscode.Extension<unknown>,
        languageModelAccessInformation: {} as unknown
    } as vscode.ExtensionContext;
}

function createStatusBarItem(): vscode.StatusBarItem {
    return {
        dispose: () => {},
        show: () => {},
        hide: () => {},
        text: '',
        tooltip: '',
        command: '',
        alignment: vscode.StatusBarAlignment.Right,
        priority: 100,
        id: 'startup-off-repair',
        name: 'Startup Off Repair'
    } as vscode.StatusBarItem;
}

function stubConfiguration(sandbox: sinon.SinonSandbox): void {
    let httpProxy = 'http://stale.example.com:8080';
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
        if (section === 'http') {
            return {
                get: (key: string, defaultValue?: unknown) => {
                    if (key === 'proxy') {
                        return httpProxy;
                    }
                    if (key === 'proxySupport') {
                        return 'on';
                    }
                    if (key === 'noProxy') {
                        return [];
                    }
                    return defaultValue;
                },
                update: async (key: string, value: unknown) => {
                    if (key === 'proxy') {
                        httpProxy = String(value ?? '');
                    }
                },
                inspect: () => undefined,
                has: () => true
            } as unknown as vscode.WorkspaceConfiguration;
        }

        return {
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'proxyUrl') {
                    return '';
                }
                if (key === 'pollingInterval') {
                    return 30;
                }
                if (key === 'maxRetries') {
                    return 3;
                }
                if (key === 'detectionSourcePriority') {
                    return ['environment', 'vscode', 'platform'];
                }
                if (key === 'notificationLevel') {
                    return 'off';
                }
                if (key === 'remediationDelayedRetryMs') {
                    return 250;
                }
                return defaultValue;
            },
            update: async () => {},
            inspect: () => undefined,
            has: () => true
        } as unknown as vscode.WorkspaceConfiguration;
    });
}

async function readGitProxy(env: NodeJS.ProcessEnv): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('git', ['config', '--global', '--get', 'http.proxy'], {
            env,
            encoding: 'utf8'
        });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

suite('Extension startup OFF self-repair', () => {
    let sandbox: sinon.SinonSandbox;
    let baseDir: string;
    let originalGitConfigGlobal: string | undefined;
    let originalNpmConfigUserconfig: string | undefined;
    let originalLowerNpmConfigUserconfig: string | undefined;
    let originalLockDir: string | undefined;

    setup(async () => {
        sandbox = sinon.createSandbox();
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-startup-off-'));
        originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
        originalNpmConfigUserconfig = process.env.NPM_CONFIG_USERCONFIG;
        originalLowerNpmConfigUserconfig = process.env.npm_config_userconfig;
        originalLockDir = process.env.OTAK_PROXY_LOCK_DIR;
        process.env.GIT_CONFIG_GLOBAL = path.join(baseDir, 'gitconfig');
        process.env.NPM_CONFIG_USERCONFIG = path.join(baseDir, 'npmrc');
        process.env.npm_config_userconfig = process.env.NPM_CONFIG_USERCONFIG;
        // Hermetic apply-lock dir so a lock left by a previous run (30s TTL) cannot
        // make this run's startup apply skip and leave the stale proxy in place.
        process.env.OTAK_PROXY_LOCK_DIR = path.join(baseDir, 'locks');

        sandbox.stub(vscode.window, 'createStatusBarItem').returns(createStatusBarItem());
        sandbox.stub(vscode.window, 'createOutputChannel').returns({
            name: 'startup-off-repair',
            logLevel: vscode.LogLevel.Info,
            onDidChangeLogLevel: () => ({ dispose: () => {} }),
            trace: () => {},
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            append: () => {},
            appendLine: () => {},
            clear: () => {},
            show: () => {},
            hide: () => {},
            dispose: () => {}
        } as unknown as vscode.LogOutputChannel);
        sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
        sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, task) =>
            task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) })
        );
        sandbox.stub(vscode.window, 'onDidChangeWindowState').returns({ dispose: () => {} });
        sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose: () => {} });
        sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => {} });
        stubConfiguration(sandbox);
    });

    teardown(async () => {
        try {
            const extension = require('../extension') as { deactivate?: () => Promise<void> };
            await extension.deactivate?.();
        } catch {
            // Module may not have been loaded if setup failed.
        }
        delete require.cache[require.resolve('../extension')];
        sandbox.restore();
        if (originalGitConfigGlobal === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
        }
        if (originalNpmConfigUserconfig === undefined) {
            delete process.env.NPM_CONFIG_USERCONFIG;
        } else {
            process.env.NPM_CONFIG_USERCONFIG = originalNpmConfigUserconfig;
        }
        if (originalLowerNpmConfigUserconfig === undefined) {
            delete process.env.npm_config_userconfig;
        } else {
            process.env.npm_config_userconfig = originalLowerNpmConfigUserconfig;
        }
        if (originalLockDir === undefined) {
            delete process.env.OTAK_PROXY_LOCK_DIR;
        } else {
            process.env.OTAK_PROXY_LOCK_DIR = originalLockDir;
        }
        await fs.rm(baseDir, { recursive: true, force: true });
    });

    test('OFF startup diagnoses and clears stale Git proxy even when tracking flags are false', async () => {
        const env = { ...process.env };
        await execFileAsync('git', ['config', '--global', 'http.proxy', 'http://stale.example.com:8080'], { env });
        await execFileAsync('git', ['config', '--global', 'https.proxy', 'http://stale.example.com:8080'], { env });
        assert.strictEqual(await readGitProxy(env), 'http://stale.example.com:8080');

        const globalState = new Map<string, unknown>([
            ['hasInitialSetup', true],
            ['proxyState', {
                mode: ProxyMode.Off,
                gitConfigured: false,
                vscodeConfigured: false,
                npmConfigured: false
            }]
        ]);
        const extension = require('../extension') as {
            activate: (context: vscode.ExtensionContext) => Promise<void>;
            whenStartupProxyApplied: () => Promise<void>;
        };
        await extension.activate(createContext(baseDir, globalState));
        // The startup enforcement is now a tracked background task (issue #12);
        // await it before asserting its side effect.
        await extension.whenStartupProxyApplied();

        assert.strictEqual(await readGitProxy(env), undefined);
    });

    test('activation does not block on the startup proxy application', async function () {
        this.timeout(10000);
        // Gate the startup apply so it cannot complete until we release it. If
        // activate() awaited the apply, this test would hang and time out; the
        // fact that activate() resolves proves activation is non-blocking (#12).
        let releaseGate!: () => void;
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });

        const globalState = new Map<string, unknown>([
            ['hasInitialSetup', true],
            ['proxyState', {
                mode: ProxyMode.Off,
                gitConfigured: false,
                vscodeConfigured: false,
                npmConfigured: false
            }]
        ]);

        const extension = require('../extension') as {
            activate: (context: vscode.ExtensionContext) => Promise<void>;
            whenStartupProxyApplied: () => Promise<void>;
            __setStartupApplyRunnerForTest: (runner?: () => Promise<void>) => void;
        };

        extension.__setStartupApplyRunnerForTest(async () => { await gate; });
        try {
            await extension.activate(createContext(baseDir, globalState));

            let applied = false;
            const tracked = extension.whenStartupProxyApplied().then(() => { applied = true; });
            await Promise.resolve();
            assert.strictEqual(applied, false, 'activation must not wait for the gated startup apply');

            releaseGate();
            await tracked;
            assert.strictEqual(applied, true, 'startup apply completes once unblocked');
        } finally {
            releaseGate();
            extension.__setStartupApplyRunnerForTest(undefined);
        }
    });

    test('startup enforcement reconciles on the latest state, not the activation snapshot', async function () {
        this.timeout(10000);
        const env = { ...process.env };
        // Precondition: a stale git proxy present at activation time.
        await execFileAsync('git', ['config', '--global', 'http.proxy', 'http://stale.example.com:8080'], { env });

        let releaseGate!: () => void;
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });

        // Snapshot at activation: Auto (a different apply target than Off below).
        const store = new Map<string, unknown>([
            ['hasInitialSetup', true],
            ['proxyState', {
                mode: ProxyMode.Auto,
                autoProxyUrl: '',
                autoModeOff: false,
                gitConfigured: false,
                vscodeConfigured: false,
                npmConfigured: false
            }]
        ]);

        const extension = require('../extension') as {
            activate: (context: vscode.ExtensionContext) => Promise<void>;
            whenStartupProxyApplied: () => Promise<void>;
            __setStartupApplyRunnerForTest: (runner?: () => Promise<void>) => void;
        };

        // Gate the initial (snapshot) apply so the "user command" below lands while
        // the startup task is mid-flight.
        extension.__setStartupApplyRunnerForTest(async () => { await gate; });
        try {
            await extension.activate(createContext(baseDir, store));

            // Simulate a user command (toggle to Off) persisting a newer state
            // while the startup apply is gated/in-flight.
            store.set('proxyState', {
                mode: ProxyMode.Off,
                gitConfigured: false,
                vscodeConfigured: false,
                npmConfigured: false
            });

            releaseGate();
            await extension.whenStartupProxyApplied();

            // Reconciliation must enforce the LATEST (Off) state — clearing the
            // proxy — rather than the stale Auto activation snapshot.
            assert.strictEqual(await readGitProxy(env), undefined);
        } finally {
            releaseGate();
            extension.__setStartupApplyRunnerForTest(undefined);
        }
    });
});
