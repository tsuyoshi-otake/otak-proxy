import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ProxyState } from '../core/types';
import {
    ExecutionContext,
    getHighestPriorityIssue,
    ProxyIssue,
    RuntimeApplyState
} from '../core/v3Types';
import { ExecutionContextDetector } from './ExecutionContextDetector';
import { CommandRunner, WindowsProxyDiagnostics } from './WindowsProxyDiagnostics';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { splitProxyUrl } from '../security/ProxyCredentialStore';

const execFileAsync = promisify(execFile);
const PROXY_ENV_NAMES = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_noproxy',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY',
    'NPM_CONFIG_NOPROXY'
];

export interface ProxyDiagnosticReport {
    generatedAt: string;
    runtimeState: RuntimeApplyState;
    executionContext: ExecutionContext;
    issueCount: number;
    highestPriorityCategory?: string;
    issues: ProxyIssue[];
    observations: Record<string, unknown>;
}

export interface ProxyRuntimeDiagnosticsOptions {
    commandRunner?: CommandRunner;
}

const defaultCommandRunner: CommandRunner = async (command, args) => execFileAsync(command, args, {
    timeout: 5000,
    encoding: 'utf8',
    windowsHide: true
});

function currentInstanceId(): string {
    return `pid-${process.pid}`;
}

function sanitizeConfigInspect(inspect: unknown): unknown {
    if (!inspect || typeof inspect !== 'object') {
        return inspect;
    }
    const output: Record<string, unknown> = {};
    for (const key of ['defaultValue', 'globalValue', 'workspaceValue', 'workspaceFolderValue', 'defaultLanguageValue', 'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue']) {
        if (key in inspect) {
            output[key] = (inspect as Record<string, unknown>)[key];
        }
    }
    return output;
}

function normalizeNpmValue(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed && trimmed !== 'undefined' && trimmed !== 'null' ? trimmed : undefined;
}

export class ProxyRuntimeDiagnostics {
    private readonly redactor = new ProxySecretRedactor();
    private readonly commandRunner: CommandRunner;
    private readonly windowsDiagnostics: WindowsProxyDiagnostics;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly stateProvider: () => Promise<ProxyState>,
        options: ProxyRuntimeDiagnosticsOptions = {}
    ) {
        this.commandRunner = options.commandRunner ?? defaultCommandRunner;
        this.windowsDiagnostics = new WindowsProxyDiagnostics(this.commandRunner);
    }

    async run(): Promise<ProxyDiagnosticReport> {
        const state = await this.stateProvider();
        const executionContext = new ExecutionContextDetector(this.context).detect();
        const knownSecrets = this.collectKnownSecrets(state);
        const issues: ProxyIssue[] = [];
        const observations: Record<string, unknown> = {};

        const vscodeDiagnostics = this.collectVSCodeDiagnostics();
        observations.vscode = vscodeDiagnostics.observation;
        issues.push(...vscodeDiagnostics.issues);

        const terminalDiagnostics = this.collectTerminalDiagnostics();
        observations.terminal = terminalDiagnostics.observation;
        issues.push(...terminalDiagnostics.issues);

        if (executionContext.canUseChildProcess) {
            const [git, npm] = await Promise.all([
                this.collectGitDiagnostics(),
                this.collectNpmDiagnostics()
            ]);
            observations.git = git.observation;
            observations.npm = npm.observation;
            issues.push(...git.issues, ...npm.issues);
        } else {
            issues.push(this.issue('diagnostics.childProcess.unavailable', 'capabilityUnavailable', 'informational', 'diagnostics.childProcess', 'web', {
                source: 'executionContext',
                capability: 'unsupported',
                evidence: { reason: 'child_process is unavailable in this context' }
            }));
        }

        if (executionContext.canReadWindowsRegistry) {
            const windowsObservation = await this.windowsDiagnostics.observe();
            observations.windows = windowsObservation;
            issues.push(...this.windowsDiagnostics.toIssues(windowsObservation));
        } else if (executionContext.workspaceHostKind !== 'localWindows') {
            issues.push(this.issue('windows.diagnostics.unavailable', 'capabilityUnavailable', 'informational', 'windows', 'unavailable', {
                source: 'executionContext',
                capability: 'unsupported',
                evidence: { workspaceHostKind: executionContext.workspaceHostKind }
            }));
        }

        const sanitizedIssues = this.redactor.redactValue(issues, knownSecrets);
        const sanitizedObservations = this.redactor.redactValue(observations, knownSecrets);
        const highest = getHighestPriorityIssue(sanitizedIssues);

        return {
            generatedAt: new Date().toISOString(),
            runtimeState: 'diagnosed',
            executionContext,
            issueCount: sanitizedIssues.length,
            highestPriorityCategory: highest?.category,
            issues: sanitizedIssues,
            observations: sanitizedObservations
        };
    }

    private collectKnownSecrets(state: ProxyState): string[] {
        const values = [
            state.manualProxyUrl,
            state.autoProxyUrl,
            state.lastSystemProxyUrl,
            state.fallbackProxyUrl
        ];
        const secrets: string[] = [];
        for (const value of values) {
            if (!value) {
                continue;
            }
            try {
                const split = splitProxyUrl(value);
                if (split.credentials?.username) {
                    secrets.push(split.credentials.username);
                }
                if (split.credentials?.password) {
                    secrets.push(split.credentials.password);
                    if (split.credentials.username) {
                        secrets.push(`${split.credentials.username}:${split.credentials.password}`);
                    }
                }
            } catch {
                // malformed values are still handled by generic redaction
            }
        }
        return secrets;
    }

    private collectVSCodeDiagnostics(): { observation: Record<string, unknown>; issues: ProxyIssue[] } {
        const config = vscode.workspace.getConfiguration('http');
        const proxy = config.get<string>('proxy');
        const proxySupport = config.get<string>('proxySupport');
        const noProxy = config.get<string[]>('noProxy');
        const argvProxyFlags = process.argv.filter(arg => /--(?:proxy-server|proxy-pac-url|no-proxy-server|proxy-bypass-list)/.test(arg));
        const issues: ProxyIssue[] = [];

        if (proxy && proxySupport === 'off') {
            issues.push(this.issue('vscode.proxySupport.off', 'externalOverride', 'advisoryResidualRisk', 'vscode.http.proxySupport', 'workspaceHost', {
                actualSanitized: proxySupport,
                source: 'vscode',
                capability: 'readOnly',
                userAction: 'changeSetting',
                evidence: { proxySupport, proxy }
            }));
        }

        if (argvProxyFlags.length > 0) {
            issues.push(this.issue('vscode.launch.proxyFlags', 'needsRestart', 'advisoryResidualRisk', 'vscode.launch.argv', 'workspaceHost', {
                source: 'process.argv',
                capability: 'readOnly',
                userAction: 'restartVSCode',
                evidence: { argvProxyFlags }
            }));
        }

        return {
            observation: {
                proxy,
                proxySupport,
                noProxy,
                proxyInspect: sanitizeConfigInspect(config.inspect<string>('proxy')),
                proxySupportInspect: sanitizeConfigInspect(config.inspect<string>('proxySupport'))
            },
            issues
        };
    }

    private collectTerminalDiagnostics(): { observation: Record<string, unknown>; issues: ProxyIssue[] } {
        const inheritedEnv = Object.fromEntries(
            PROXY_ENV_NAMES
                .filter(name => process.env[name])
                .map(name => [name, process.env[name]])
        );
        const collection = (this.context as Partial<vscode.ExtensionContext>).environmentVariableCollection;
        const mutators: Record<string, unknown> = {};
        if (collection) {
            for (const [variable, mutator] of collection) {
                if (PROXY_ENV_NAMES.includes(variable)) {
                    mutators[variable] = {
                        type: mutator.type,
                        value: mutator.value,
                        options: mutator.options
                    };
                }
            }
        }

        const issues: ProxyIssue[] = [];
        if (Object.keys(inheritedEnv).length > 0) {
            issues.push(this.issue('terminal.inheritedProxyEnv', 'externalOverride', 'advisoryResidualRisk', 'terminal.env.inherited', 'workspaceHost', {
                source: 'process.env',
                capability: 'readOnly',
                evidence: { inheritedEnv }
            }));
        }

        if (vscode.window.terminals.length > 0) {
            issues.push(this.issue('terminal.existingTerminals', 'needsNewTerminal', 'advisoryResidualRisk', 'terminal.existing', 'workspaceHost', {
                source: 'vscode.window.terminals',
                capability: 'readOnly',
                userAction: 'openNewTerminal',
                evidence: { terminalCount: vscode.window.terminals.length }
            }));
        }

        return {
            observation: {
                inheritedEnv,
                mutators,
                terminalCount: vscode.window.terminals.length,
                collectionPersistent: collection?.persistent,
                collectionDescription: collection?.description?.toString()
            },
            issues
        };
    }

    private async collectGitDiagnostics(): Promise<{ observation: Record<string, unknown>; issues: ProxyIssue[] }> {
        const observation: Record<string, unknown> = {};
        const issues: ProxyIssue[] = [];
        const httpProxy = await this.readGitConfig(['config', '--global', '--get', 'http.proxy']);
        const httpsProxy = await this.readGitConfig(['config', '--global', '--get', 'https.proxy']);
        const overrides = await this.readGitConfig(['config', '--get-regexp', '^(remote\\..*\\.proxy|http\\..*\\.proxy)$']);
        observation.httpProxy = httpProxy;
        observation.legacyHttpsProxy = httpsProxy;
        observation.overrides = overrides;

        if (httpsProxy) {
            issues.push(this.issue('git.legacyHttpsProxy', 'info', 'informational', 'git.global.https.proxy', 'workspaceHost', {
                source: 'git config',
                capability: 'readOnly',
                evidence: { legacyHttpsProxy: httpsProxy }
            }));
        }
        if (overrides) {
            issues.push(this.issue('git.effectiveOverride', 'externalOverride', 'informational', 'git.override', 'workspaceHost', {
                source: 'git config',
                capability: 'readOnly',
                evidence: { overrides }
            }));
        }

        return { observation, issues };
    }

    private async collectNpmDiagnostics(): Promise<{ observation: Record<string, unknown>; issues: ProxyIssue[] }> {
        const proxy = normalizeNpmValue(await this.readNpmConfig('proxy') ?? '');
        const httpsProxy = normalizeNpmValue(await this.readNpmConfig('https-proxy') ?? '');
        const noproxy = normalizeNpmValue(await this.readNpmConfig('noproxy') ?? '');
        const registry = normalizeNpmValue(await this.readNpmConfig('registry') ?? '');
        const observation = { proxy, httpsProxy, noproxy, registry };
        const issues: ProxyIssue[] = [];

        if (noproxy) {
            issues.push(this.issue('npm.noproxy', 'info', 'informational', 'npm.noproxy', 'workspaceHost', {
                source: 'npm config',
                capability: 'readOnly',
                evidence: { noproxy, registry }
            }));
        }

        return { observation, issues };
    }

    private async readGitConfig(args: string[]): Promise<string | undefined> {
        try {
            const { stdout } = await this.commandRunner('git', args);
            return stdout.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private async readNpmConfig(key: string): Promise<string | undefined> {
        try {
            if (process.platform === 'win32') {
                const comspec = process.env.ComSpec || 'cmd.exe';
                const { stdout } = await this.commandRunner(comspec, ['/d', '/s', '/c', 'npm', 'config', 'get', key]);
                return stdout.trim();
            }
            const { stdout } = await this.commandRunner('npm', ['config', 'get', key]);
            return stdout.trim();
        } catch {
            return undefined;
        }
    }

    private issue(
        id: string,
        category: ProxyIssue['category'],
        impact: ProxyIssue['impact'],
        targetId: string,
        targetHost: ProxyIssue['targetHost'],
        options: Partial<Omit<ProxyIssue, 'id' | 'fingerprint' | 'category' | 'impact' | 'targetId' | 'targetHost'>> = {}
    ): ProxyIssue {
        return {
            id,
            fingerprint: `${id}:${targetId}:${currentInstanceId()}`,
            category,
            impact,
            targetId,
            targetHost,
            source: options.source ?? 'diagnostics',
            capability: options.capability ?? 'readOnly',
            autoAction: options.autoAction ?? 'none',
            userAction: options.userAction ?? 'showDetails',
            evidence: options.evidence ?? {},
            expectedSanitized: options.expectedSanitized,
            actualSanitized: options.actualSanitized
        };
    }
}
