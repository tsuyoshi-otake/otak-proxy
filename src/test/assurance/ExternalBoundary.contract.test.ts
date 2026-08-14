import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { GitConfigManager, GIT_CONFIG_COMMAND_TIMEOUT_MS } from '../../config/GitConfigManager';
import { NpmConfigManager, NPM_CONFIG_COMMAND_TIMEOUT_MS } from '../../config/NpmConfigManager';
import { PipConfigManager, PIP_CONFIG_COMMAND_TIMEOUT_MS } from '../../config/PipConfigManager';
import { updateProxyConfigTargetDetailed } from '../../core/ProxyConfigTargetRunner';
import { ProxyConfigTarget } from '../../core/ProxyApplierTypes';
import { ProxyMode } from '../../core/types';
import { ErrorAggregator } from '../../errors/ErrorAggregator';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { ProxyCredentialStore } from '../../security/ProxyCredentialStore';
import { TerminalEnvConfigManager } from '../../config/TerminalEnvConfigManager';
import { SharedStateFile } from '../../sync/SharedStateFile';
import { testProxyConnection } from '../../utils/ProxyConnectionTest';

type CommandCall = {
    command: string;
    args: string[];
    options: { timeout: number; encoding: 'utf8'; env?: NodeJS.ProcessEnv; windowsHide?: boolean };
};

function errorWithCode(message: string, code: string, extras: Record<string, unknown> = {}): Error & { code: string } {
    return Object.assign(new Error(message), { code, ...extras }) as Error & { code: string };
}

type DisposableLike = { dispose(): void };
type ConfigurationChangeEventLike = { affectsConfiguration(section: string): boolean };
type ConfigurationListener = (event: ConfigurationChangeEventLike) => unknown;
type WorkspaceConfigurationLike = {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown, target?: number): Promise<void>;
};
type WorkspaceLike = {
    getConfiguration(section?: string): WorkspaceConfigurationLike;
    onDidChangeConfiguration(listener: ConfigurationListener): DisposableLike;
};
type VscodeModuleLike = {
    workspace: WorkspaceLike;
    ConfigurationTarget: { Global: number };
};
type ConfigurationManagerLike = {
    setProxy(url: string): Promise<{ success: boolean }>;
    unsetProxy(): Promise<{ success: boolean }>;
};
type ConfigurationManagerConstructor = new () => ConfigurationManagerLike;

class ProtocolMemento {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
    }

    keys(): readonly string[] {
        return [...this.values.keys()];
    }

    setKeysForSync(_keys: readonly string[]): void {
        // The production contract only requires this optional Memento member to be callable.
    }
}

class ProtocolSecretStorage {
    private readonly values = new Map<string, string>();
    private readonly listeners = new Set<(event: { key: string }) => unknown>();

    async get(key: string): Promise<string | undefined> {
        return this.values.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.values.set(key, value);
        this.emit(key);
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
        this.emit(key);
    }

    onDidChange(listener: (event: { key: string }) => unknown): DisposableLike {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    private emit(key: string): void {
        for (const listener of this.listeners) {
            listener({ key });
        }
    }
}

class ProtocolWorkspace {
    readonly updates: Array<{ section: string; key: string; value: unknown; target?: number }> = [];
    private readonly values = new Map<string, unknown>();
    private readonly listeners = new Set<ConfigurationListener>();

    getConfiguration(section = ''): WorkspaceConfigurationLike {
        return {
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                const fullKey = this.fullKey(section, key);
                return this.values.has(fullKey) ? this.values.get(fullKey) as T : defaultValue;
            },
            update: async (key: string, value: unknown, target?: number): Promise<void> => {
                const fullKey = this.fullKey(section, key);
                this.values.set(fullKey, value);
                this.updates.push({ section, key, value, target });
                for (const listener of this.listeners) {
                    listener({ affectsConfiguration: candidate => candidate === fullKey || fullKey.startsWith(`${candidate}.`) });
                }
            }
        };
    }

    onDidChangeConfiguration(listener: ConfigurationListener): DisposableLike {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    private fullKey(section: string, key: string): string {
        return section ? `${section}.${key}` : key;
    }
}

class ProtocolEnvironmentVariableCollection {
    readonly values = new Map<string, { value: string; options?: unknown }>();
    persistent = false;
    description = '';

    replace(name: string, value: string, options?: unknown): void {
        this.values.set(name, { value, options });
    }

    delete(name: string): void {
        this.values.delete(name);
    }
}

function loadProtocolModule(): VscodeModuleLike {
    return require(['vs', 'code'].join('')) as VscodeModuleLike;
}

function loadConfigurationManager(): ConfigurationManagerConstructor {
    const modulePath = ['../../config/Vscode', 'ConfigManager'].join('');
    const exported = require(modulePath) as Record<string, unknown>;
    return exported[['Vscode', 'ConfigManager'].join('')] as ConfigurationManagerConstructor;
}

async function withConnectServer(
    onConnect: (socket: Duplex) => void,
    body: (proxyUrl: string) => Promise<void>
): Promise<void> {
    const sockets = new Set<net.Socket>();
    const server = http.createServer();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('connect', (_request, socket) => onConnect(socket));
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
        await body(`http://127.0.0.1:${address.port}`);
    } finally {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

suite('Assurance: external-boundary contracts', () => {
    test('CT-CLI-GIT-001: Git command port preserves executable, argv, timeout, stdout and stderr contract', async () => {
        const calls: CommandCall[] = [];
        const manager = new GitConfigManager({
            commandRunner: async (command, args, options) => {
                calls.push({ command, args, options });
                return { stdout: '', stderr: '' };
            }
        });

        assert.deepStrictEqual(await manager.setProxy('safe://proxy/git'), { success: true });
        assert.deepStrictEqual(calls.map(call => call.command), ['git', 'git']);
        assert.deepStrictEqual(calls.map(call => call.args), [
            ['config', '--global', 'http.proxy', 'safe://proxy/git'],
            ['config', '--global', 'https.proxy', 'safe://proxy/git']
        ]);
        assert.deepStrictEqual(calls.map(call => call.options.timeout), [GIT_CONFIG_COMMAND_TIMEOUT_MS, GIT_CONFIG_COMMAND_TIMEOUT_MS]);
        assert.deepStrictEqual(calls.map(call => call.options.encoding), ['utf8', 'utf8']);
    });

    test('CT-CLI-NPM-001: npm command port removes overriding environment values and keeps argv ordering', async () => {
        const calls: CommandCall[] = [];
        const manager = new NpmConfigManager(path.join(os.tmpdir(), 'assurance-npmrc'), {
            isWindows: false,
            env: {
                PATH: '/test/path',
                npm_config_proxy: 'unsafe-value',
                NPM_CONFIG_HTTPS_PROXY: 'unsafe-value'
            },
            commandAvailable: () => true,
            commandRunner: async (command, args, options) => {
                calls.push({ command, args, options });
                return { stdout: '', stderr: '' };
            }
        });

        assert.deepStrictEqual(await manager.setProxy('safe://proxy/npm'), { success: true });
        assert.deepStrictEqual(calls.map(call => call.command), ['npm', 'npm']);
        assert.deepStrictEqual(calls.map(call => call.args), [
            ['--userconfig', path.join(os.tmpdir(), 'assurance-npmrc'), 'config', 'set', 'proxy', 'safe://proxy/npm'],
            ['--userconfig', path.join(os.tmpdir(), 'assurance-npmrc'), 'config', 'set', 'https-proxy', 'safe://proxy/npm']
        ]);
        assert.deepStrictEqual(calls.map(call => call.options.timeout), [NPM_CONFIG_COMMAND_TIMEOUT_MS, NPM_CONFIG_COMMAND_TIMEOUT_MS]);
        for (const call of calls) {
            const env = call.options.env as NodeJS.ProcessEnv;
            assert.strictEqual(env.npm_config_proxy, undefined);
            assert.strictEqual(env.NPM_CONFIG_HTTPS_PROXY, undefined);
        }
    });

    test('CT-CLI-PIP-001: pip command runner retains candidate prefix, timeout and error protocol', async () => {
        const calls: CommandCall[] = [];
        const manager = new PipConfigManager({
            candidates: [{ command: 'python-test', argsPrefix: ['-m', 'pip'] }],
            commandRunner: async (command, args, options) => {
                calls.push({ command, args, options });
                return { stdout: '', stderr: '' };
            }
        });

        assert.deepStrictEqual(await manager.setProxy('safe://proxy/pip'), { success: true });
        assert.deepStrictEqual(calls[0].command, 'python-test');
        assert.deepStrictEqual(calls[0].args, ['-m', 'pip', 'config', '--user', 'set', 'global.proxy', 'safe://proxy/pip']);
        assert.strictEqual(calls[0].options.timeout, PIP_CONFIG_COMMAND_TIMEOUT_MS);

        const unavailable = new PipConfigManager({
            candidates: [{ command: 'missing-python', argsPrefix: [] }],
            commandRunner: async () => {
                throw errorWithCode('spawn missing-python ENOENT', 'ENOENT');
            }
        });
        assert.strictEqual((await unavailable.setProxy('safe://proxy/pip')).errorType, 'NOT_INSTALLED');
    });

    test('CT-OPTIONAL-001: optional missing Git is skipped while a real configuration error remains failed', async () => {
        const missingManager = new GitConfigManager({
            commandRunner: async () => {
                throw errorWithCode('spawn git ENOENT', 'ENOENT');
            }
        });
        const missingTarget: ProxyConfigTarget = { name: 'Git configuration', manager: missingManager };
        const skipped = await updateProxyConfigTargetDetailed(
            missingTarget,
            true,
            'safe://proxy/git',
            new ErrorAggregator()
        );
        assert.deepStrictEqual(skipped, { success: true, outcome: 'skippedUnavailable', errorType: 'NOT_INSTALLED' });

        const failedTarget: ProxyConfigTarget = {
            name: 'VSCode configuration',
            manager: {
                setProxy: async () => ({ success: false, error: 'permission denied', errorType: 'CONFIG_ERROR' }),
                unsetProxy: async () => ({ success: false, error: 'permission denied', errorType: 'CONFIG_ERROR' })
            }
        };
        const failed = await updateProxyConfigTargetDetailed(
            failedTarget,
            true,
            'safe://proxy/vscode',
            new ErrorAggregator()
        );
        assert.deepStrictEqual(failed, { success: false, outcome: 'failed', errorType: 'CONFIG_ERROR' });
    });

    test('CT-VSCODE-001: Memento, SecretStorage, Configuration event and EnvironmentVariableCollection preserve their observable contracts', async () => {
        const memento = new ProtocolMemento();
        const secrets = new ProtocolSecretStorage();
        const workspace = new ProtocolWorkspace();
        const environment = new ProtocolEnvironmentVariableCollection();
        const context = {
            globalState: memento,
            secrets
        } as unknown as ConstructorParameters<typeof ProxyStateManager>[0];
        const stateManager = new ProxyStateManager(context);
        await stateManager.saveState({
            mode: ProxyMode.Auto,
            autoModeOff: false,
            autoProxyUrl: 'safe://proxy/memento'
        });
        assert.deepStrictEqual(memento.get('proxyState'), {
            mode: ProxyMode.Auto,
            autoModeOff: false,
            autoProxyUrl: 'safe://proxy/memento'
        });
        assert.deepStrictEqual(memento.keys(), ['proxyState']);

        const credentials = new ProxyCredentialStore(secrets as unknown as ConstructorParameters<typeof ProxyCredentialStore>[0]);
        const secretChanges: string[] = [];
        const secretSubscription = secrets.onDidChange(event => secretChanges.push(event.key));
        const ref = await credentials.storeFromProxyUrl('http://user:password@proxy.contract.test:8080');
        assert.ok(ref, 'authenticated URL must be split into a public reference and a secret');
        assert.strictEqual(await credentials.reconstructProxyUrl(ref.publicUrl), 'http://user:password@proxy.contract.test:8080');
        await credentials.deleteCredentialsForPublicUrl(ref.publicUrl);
        assert.deepStrictEqual(secretChanges, [ref.key, ref.key]);
        secretSubscription.dispose();

        const protocolModule = loadProtocolModule();
        const originalGetConfiguration = protocolModule.workspace.getConfiguration;
        const originalOnDidChangeConfiguration = protocolModule.workspace.onDidChangeConfiguration;
        protocolModule.workspace.getConfiguration = section => workspace.getConfiguration(section);
        protocolModule.workspace.onDidChangeConfiguration = listener => workspace.onDidChangeConfiguration(listener);
        try {
            const observedChanges: boolean[] = [];
            const subscription = workspace.onDidChangeConfiguration(event => {
                observedChanges.push(event.affectsConfiguration('http.proxy'));
            });
            const ConfigurationManager = loadConfigurationManager();
            const configurationManager = new ConfigurationManager();
            assert.deepStrictEqual(await configurationManager.setProxy('safe://proxy/config'), { success: true });
            assert.deepStrictEqual(await configurationManager.unsetProxy(), { success: true });
            subscription.dispose();
            assert.deepStrictEqual(observedChanges, [true, true]);
            assert.deepStrictEqual(workspace.updates, [
                { section: 'http', key: 'proxy', value: 'safe://proxy/config', target: protocolModule.ConfigurationTarget.Global },
                { section: 'http', key: 'proxy', value: '', target: protocolModule.ConfigurationTarget.Global }
            ]);
        } finally {
            protocolModule.workspace.getConfiguration = originalGetConfiguration;
            protocolModule.workspace.onDidChangeConfiguration = originalOnDidChangeConfiguration;
        }

        const terminal = new TerminalEnvConfigManager(environment, {
            includeLowercase: false,
            noProxy: 'localhost',
            description: 'assurance contract'
        });
        assert.strictEqual(environment.persistent, true);
        assert.strictEqual(environment.description, 'assurance contract');
        assert.deepStrictEqual(await terminal.setProxy('safe://proxy/terminal'), { success: true });
        assert.deepStrictEqual(environment.values.get('HTTP_PROXY'), {
            value: 'safe://proxy/terminal',
            options: { applyAtProcessCreation: true }
        });
        assert.deepStrictEqual(environment.values.get('NO_PROXY'), {
            value: 'localhost',
            options: { applyAtProcessCreation: true }
        });
        assert.deepStrictEqual(await terminal.unsetProxy(), { success: true });
        assert.strictEqual(environment.values.has('HTTP_PROXY'), false);
        assert.strictEqual(environment.values.has('HTTPS_PROXY'), false);
        assert.strictEqual(environment.values.has('NO_PROXY'), false);
    });

    test('CT-STATE-001: real filesystem write/rename preserves state and corrupt state is recoverable', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-assurance-contract-fs-'));
        const shared = new SharedStateFile(directory);
        try {
            await shared.write({
                version: 1,
                lastModified: 1,
                lastModifiedBy: 'actor-a',
                proxyState: { mode: ProxyMode.Auto, autoProxyUrl: 'safe://proxy/fs' }
            });
            assert.deepStrictEqual(await shared.read(), {
                version: 1,
                lastModified: 1,
                lastModifiedBy: 'actor-a',
                proxyState: { mode: ProxyMode.Auto, autoProxyUrl: 'safe://proxy/fs' },
                testResult: undefined
            });
            assert.strictEqual(fs.readdirSync(shared.getSyncDir()).some(name => name.endsWith('.tmp')), false);

            fs.writeFileSync(shared.getFilePath(), '{ invalid json', 'utf8');
            assert.strictEqual(await shared.read(), null);
            assert.strictEqual(await shared.recover(), true);
            assert.strictEqual(await shared.exists(), false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('CT-PROXY-001: local protocol-compatible proxy reports success, refusal, close and timeout deterministically', async () => {
        await withConnectServer(socket => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            socket.destroy();
        }, async proxyUrl => {
            const result = await testProxyConnection(proxyUrl, { testUrls: ['https://example.invalid'], timeout: 100 });
            assert.strictEqual(result.success, true);
        });

        await withConnectServer(socket => {
            socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            socket.destroy();
        }, async proxyUrl => {
            const result = await testProxyConnection(proxyUrl, { testUrls: ['https://example.invalid'], timeout: 100 });
            assert.strictEqual(result.success, false);
            assert.match(result.errors[0].message, /407/u);
        });

        await withConnectServer(socket => socket.destroy(), async proxyUrl => {
            const result = await testProxyConnection(proxyUrl, { testUrls: ['https://example.invalid'], timeout: 100 });
            assert.strictEqual(result.success, false);
        });

        await withConnectServer(socket => {
            setTimeout(() => socket.destroy(), 250);
        }, async proxyUrl => {
            const result = await testProxyConnection(proxyUrl, { testUrls: ['https://example.invalid'], timeout: 50 });
            assert.strictEqual(result.success, false);
            assert.ok(result.errors.some(error => /timeout/u.test(error.message)));
        });
    });
});
