import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
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
import { readV3Settings } from '../core/V3Settings';

export interface ProxyRuntimeDiagnosticsRunOptions {
    bypassSlowCache?: boolean;
}

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

type DiagnosticPart = { observation: Record<string, unknown>; issues: ProxyIssue[] };

interface SlowDiagnosticsCache {
    expiresAt: number;
    canUseChildProcess: boolean;
    canReadWindowsRegistry: boolean;
    workspaceHostKind: string;
    git?: DiagnosticPart;
    npm?: DiagnosticPart;
    windows?: { observation: unknown; issues: ProxyIssue[] };
}

const defaultCommandRunner: CommandRunner = async (command, args) => execFileAsync(command, args, {
    timeout: 5000,
    encoding: 'utf8',
    windowsHide: true
});

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

interface GitConfigRead {
    value?: string;
    readFailed?: boolean;
}

/**
 * `git config --get[-regexp]` exits 1 when the requested key/section is simply
 * not present — the normal "not configured" case. Any other exit code (e.g. 3 =
 * unparsable .gitconfig) or a spawn failure (git not installed surfaces a string
 * `code` such as 'ENOENT') means we could not read the value at all, which must
 * not be mistaken for "unset" (#16).
 */
function isGitKeyUnsetError(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 1;
}

export class ProxyRuntimeDiagnostics {
    private readonly redactor = new ProxySecretRedactor();
    private readonly commandRunner: CommandRunner;
    private readonly windowsDiagnostics: WindowsProxyDiagnostics;
    private slowCache: SlowDiagnosticsCache | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly stateProvider: () => Promise<ProxyState>,
        options: ProxyRuntimeDiagnosticsOptions = {}
    ) {
        this.commandRunner = options.commandRunner ?? defaultCommandRunner;
        this.windowsDiagnostics = new WindowsProxyDiagnostics(this.commandRunner);
    }

    async run(options: ProxyRuntimeDiagnosticsRunOptions = {}): Promise<ProxyDiagnosticReport> {
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

        const slowDiagnostics = await this.collectSlowDiagnostics(executionContext, options.bypassSlowCache === true);
        if (slowDiagnostics.git && slowDiagnostics.npm) {
            const git = slowDiagnostics.git;
            const npm = slowDiagnostics.npm;
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

        if (slowDiagnostics.windows) {
            observations.windows = slowDiagnostics.windows.observation;
            issues.push(...slowDiagnostics.windows.issues);
        } else if (executionContext.workspaceHostKind !== 'localWindows') {
            issues.push(this.issue('windows.diagnostics.unavailable', 'capabilityUnavailable', 'informational', 'windows', 'unavailable', {
                source: 'executionContext',
                capability: 'unsupported',
                evidence: { workspaceHostKind: executionContext.workspaceHostKind }
            }));
        }

        issues.push(...this.collectManagedConvergenceIssues(state, {
            git: slowDiagnostics.git?.observation,
            npm: slowDiagnostics.npm?.observation,
            vscode: vscodeDiagnostics.observation
        }));

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

    private async collectSlowDiagnostics(executionContext: ExecutionContext, bypassCache: boolean): Promise<SlowDiagnosticsCache> {
        const settings = readV3Settings();
        const now = Date.now();
        if (!bypassCache &&
            this.slowCache &&
            this.slowCache.expiresAt > now &&
            this.slowCache.canUseChildProcess === executionContext.canUseChildProcess &&
            this.slowCache.canReadWindowsRegistry === executionContext.canReadWindowsRegistry &&
            this.slowCache.workspaceHostKind === executionContext.workspaceHostKind) {
            return this.slowCache;
        }

        const cache: SlowDiagnosticsCache = {
            expiresAt: now + settings.slowDiagnosticsTtlMs,
            canUseChildProcess: executionContext.canUseChildProcess,
            canReadWindowsRegistry: executionContext.canReadWindowsRegistry,
            workspaceHostKind: executionContext.workspaceHostKind
        };

        if (executionContext.canUseChildProcess) {
            const [git, npm] = await Promise.all([
                this.collectGitDiagnostics(),
                this.collectNpmDiagnostics()
            ]);
            cache.git = git;
            cache.npm = npm;
        }

        if (executionContext.canReadWindowsRegistry) {
            const observation = await this.windowsDiagnostics.observe();
            cache.windows = {
                observation,
                issues: this.windowsDiagnostics.toIssues(observation)
            };
        }

        this.slowCache = cache;
        return cache;
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
        const [httpProxy, httpsProxy, overrides] = await Promise.all([
            this.readGitConfig(['config', '--global', '--get', 'http.proxy']),
            this.readGitConfig(['config', '--global', '--get', 'https.proxy']),
            this.readGitConfig(['config', '--get-regexp', '^(remote\\..*\\.proxy|http\\..*\\.proxy)$'])
        ]);
        observation.httpProxy = httpProxy.value;
        observation.legacyHttpsProxy = httpsProxy.value;
        observation.overrides = overrides.value;
        // Only the two --get reads feed convergence checking; the regexp read
        // only informs git.effectiveOverride. Flag a convergence-blocking read
        // failure so the managed-mismatch check can skip an unreadable value
        // instead of treating it as "unset" (#16).
        observation.readFailed = Boolean(httpProxy.readFailed || httpsProxy.readFailed);

        if (httpsProxy.value) {
            issues.push(this.issue('git.legacyHttpsProxy', 'info', 'informational', 'git.global.https.proxy', 'workspaceHost', {
                source: 'git config',
                capability: 'readOnly',
                evidence: { legacyHttpsProxy: httpsProxy.value }
            }));
        }
        if (overrides.value) {
            issues.push(this.issue('git.effectiveOverride', 'externalOverride', 'informational', 'git.override', 'workspaceHost', {
                source: 'git config',
                capability: 'readOnly',
                evidence: { overrides: overrides.value }
            }));
        }

        return { observation, issues };
    }

    private async collectNpmDiagnostics(): Promise<{ observation: Record<string, unknown>; issues: ProxyIssue[] }> {
        const [proxy, httpsProxy, noproxy, registry] = (await Promise.all([
            this.readNpmConfig('proxy'),
            this.readNpmConfig('https-proxy'),
            this.readNpmConfig('noproxy'),
            this.readNpmConfig('registry')
        ])).map(value => normalizeNpmValue(value ?? ''));
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

    private collectManagedConvergenceIssues(
        state: ProxyState,
        observations: { git?: Record<string, unknown>; npm?: Record<string, unknown>; vscode?: Record<string, unknown> }
    ): ProxyIssue[] {
        const issues: ProxyIssue[] = [];
        const gitReadFailed = this.observedFlag(observations.git, 'readFailed');

        // When we manage git's proxy but could not read git config at all (e.g.
        // an unparsable .gitconfig or a missing git binary), we cannot verify
        // convergence. Surface it as informational and skip the retryable git
        // mismatch/residual below: retries cannot fix a read failure, and
        // treating an unreadable value as "unset" would demand pointless apply
        // retries (#16).
        if (state.gitConfigured && gitReadFailed) {
            issues.push(this.issue('git.readUnavailable', 'capabilityUnavailable', 'informational', 'git.global.proxy', 'workspaceHost', {
                source: 'git config',
                capability: 'unsupported',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    gitConfigured: state.gitConfigured
                }
            }));
        }

        if (this.expectsProxyDisabled(state)) {
            issues.push(...this.collectManagedResidualIssues(state, observations));
            return issues;
        }

        const expectedProxy = this.expectedActiveProxyUrl(state);
        if (!expectedProxy) {
            return issues;
        }

        const gitHttpProxy = this.observedString(observations.git, 'httpProxy');
        const gitHttpsProxy = this.observedString(observations.git, 'legacyHttpsProxy');
        if (state.gitConfigured && !gitReadFailed &&
            (!this.proxyMatchesExpected(gitHttpProxy, expectedProxy) ||
                !this.proxyMatchesExpected(gitHttpsProxy, expectedProxy))) {
            issues.push(this.issue('git.managedProxyMismatch', 'applyFailed', 'blocksConvergence', 'git.global.proxy', 'workspaceHost', {
                expectedSanitized: expectedProxy,
                actualSanitized: gitHttpProxy ?? gitHttpsProxy ?? 'unset',
                source: 'git config',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    gitConfigured: state.gitConfigured,
                    expectedProxy,
                    httpProxy: gitHttpProxy,
                    legacyHttpsProxy: gitHttpsProxy
                }
            }));
        }

        const npmProxy = this.observedString(observations.npm, 'proxy');
        const npmHttpsProxy = this.observedString(observations.npm, 'httpsProxy');
        if (state.npmConfigured &&
            (!this.proxyMatchesExpected(npmProxy, expectedProxy) ||
                !this.proxyMatchesExpected(npmHttpsProxy, expectedProxy))) {
            issues.push(this.issue('npm.managedProxyMismatch', 'applyFailed', 'blocksConvergence', 'npm.user.proxy', 'workspaceHost', {
                expectedSanitized: expectedProxy,
                actualSanitized: npmProxy ?? npmHttpsProxy ?? 'unset',
                source: 'npm config',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    npmConfigured: state.npmConfigured,
                    expectedProxy,
                    proxy: npmProxy,
                    httpsProxy: npmHttpsProxy
                }
            }));
        }

        const vscodeProxy = this.observedString(observations.vscode, 'proxy');
        if (state.vscodeConfigured && !this.proxyMatchesExpected(vscodeProxy, expectedProxy)) {
            issues.push(this.issue('vscode.managedProxyMismatch', 'applyFailed', 'blocksConvergence', 'vscode.http.proxy', 'workspaceHost', {
                expectedSanitized: expectedProxy,
                actualSanitized: vscodeProxy ?? 'unset',
                source: 'vscode',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    vscodeConfigured: state.vscodeConfigured,
                    expectedProxy,
                    proxy: vscodeProxy
                }
            }));
        }

        return issues;
    }

    private collectManagedResidualIssues(
        state: ProxyState,
        observations: { git?: Record<string, unknown>; npm?: Record<string, unknown>; vscode?: Record<string, unknown> }
    ): ProxyIssue[] {
        const issues: ProxyIssue[] = [];
        const gitHttpProxy = this.observedString(observations.git, 'httpProxy');
        const gitHttpsProxy = this.observedString(observations.git, 'legacyHttpsProxy');
        if (gitHttpProxy || gitHttpsProxy) {
            issues.push(this.issue('git.managedProxyResidual', 'applyFailed', 'blocksConvergence', 'git.global.proxy', 'workspaceHost', {
                expectedSanitized: 'unset',
                actualSanitized: gitHttpProxy ?? gitHttpsProxy,
                source: 'git config',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    gitConfigured: state.gitConfigured,
                    httpProxy: gitHttpProxy,
                    legacyHttpsProxy: gitHttpsProxy
                }
            }));
        }

        const npmProxy = this.observedString(observations.npm, 'proxy');
        const npmHttpsProxy = this.observedString(observations.npm, 'httpsProxy');
        if (npmProxy || npmHttpsProxy) {
            issues.push(this.issue('npm.managedProxyResidual', 'applyFailed', 'blocksConvergence', 'npm.user.proxy', 'workspaceHost', {
                expectedSanitized: 'unset',
                actualSanitized: npmProxy ?? npmHttpsProxy,
                source: 'npm config',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    npmConfigured: state.npmConfigured,
                    proxy: npmProxy,
                    httpsProxy: npmHttpsProxy
                }
            }));
        }

        const vscodeProxy = this.observedString(observations.vscode, 'proxy');
        if (vscodeProxy) {
            issues.push(this.issue('vscode.managedProxyResidual', 'applyFailed', 'blocksConvergence', 'vscode.http.proxy', 'workspaceHost', {
                expectedSanitized: 'unset',
                actualSanitized: vscodeProxy,
                source: 'vscode',
                capability: 'readOnly',
                evidence: {
                    mode: state.mode,
                    autoModeOff: state.autoModeOff,
                    vscodeConfigured: state.vscodeConfigured,
                    proxy: vscodeProxy
                }
            }));
        }

        return issues;
    }

    private expectedActiveProxyUrl(state: ProxyState): string | undefined {
        if (state.mode === ProxyMode.Off) {
            return undefined;
        }
        if (state.mode === ProxyMode.Auto) {
            return state.autoProxyUrl || state.fallbackProxyUrl;
        }
        return state.manualProxyUrl;
    }

    private expectsProxyDisabled(state: ProxyState): boolean {
        return state.mode === ProxyMode.Off ||
            (state.mode === ProxyMode.Auto && state.autoModeOff === true && !state.autoProxyUrl && !state.usingFallbackProxy);
    }

    private observedString(observation: Record<string, unknown> | undefined, key: string): string | undefined {
        const value = observation?.[key];
        return typeof value === 'string' && value.trim() ? value : undefined;
    }

    private observedFlag(observation: Record<string, unknown> | undefined, key: string): boolean {
        return observation?.[key] === true;
    }

    private proxyMatchesExpected(observed: string | undefined, expected: string): boolean {
        if (!observed) {
            return false;
        }
        return this.normalizeProxyForComparison(observed) === this.normalizeProxyForComparison(expected);
    }

    private normalizeProxyForComparison(value: string): string {
        const trimmed = value.trim();
        try {
            return new URL(trimmed).toString();
        } catch {
            return trimmed;
        }
    }

    private async readGitConfig(args: string[]): Promise<GitConfigRead> {
        try {
            const { stdout } = await this.commandRunner('git', args);
            return { value: stdout.trim() || undefined };
        } catch (error) {
            // Exit 1 means the key is unset; anything else (bad config, missing
            // git) is a read failure we must not report as "unset" (#16).
            if (isGitKeyUnsetError(error)) {
                return { value: undefined };
            }
            return { value: undefined, readFailed: true };
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
            // Stable across restarts and windows: this keys the cross-window
            // notification cooldown persisted in globalState.
            fingerprint: `${id}:${targetId}`,
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
