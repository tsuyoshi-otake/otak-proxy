import { I18nManager } from '../i18n/I18nManager';

/**
 * Maps a target id to its localized label key. Kept as data (not inline
 * strings) so every target is localized through the locale files (issue #13).
 * One map serves the diagnostics report and the Off warning that names the
 * values it kept; the ownership ids (`git.global.http.proxy`,
 * `npm.user.https-proxy`, ...) are the ones the target adapters in
 * `ProxyApplier` observe, the others are the diagnostics ids.
 */
export const TARGET_LABEL_KEYS: Readonly<Record<string, string>> = {
    'git.global.proxy': 'diagnose.target.gitGlobalProxy',
    'git.global.http.proxy': 'diagnose.target.gitGlobalHttpProxy',
    'git.global.https.proxy': 'diagnose.target.gitGlobalHttpsProxy',
    'git.override': 'diagnose.target.gitOverride',
    'npm.user.proxy': 'diagnose.target.npmUserProxy',
    'npm.user.https-proxy': 'diagnose.target.npmUserHttpsProxy',
    'npm.noproxy': 'diagnose.target.npmNoproxy',
    'vscode.http.proxy': 'diagnose.target.vscodeHttpProxy',
    'vscode.http.proxySupport': 'diagnose.target.vscodeHttpProxySupport',
    'vscode.launch.argv': 'diagnose.target.vscodeLaunchArgv',
    'terminal.env.inherited': 'diagnose.target.terminalEnvInherited',
    'terminal.existing': 'diagnose.target.terminalExisting',
    'diagnostics.childProcess': 'diagnose.target.diagnosticsChildProcess',
    'windows': 'diagnose.target.windows',
    'windows.winhttp': 'diagnose.target.windowsWinhttp',
    'windows.wininet': 'diagnose.target.windowsWininet',
    'system.bypass': 'diagnose.target.systemBypass',
    'pip.user.global.proxy': 'diagnose.target.pipUserProxy',
    'linux.gnome': 'diagnose.target.linuxGnome',
    'macos.network': 'diagnose.target.macosNetwork',
    'proxy.credentials': 'diagnose.target.proxyCredentials',
    'workspace.apply': 'diagnose.target.workspaceApply'
};

/** The localized label of a target, or its raw id when no label is defined. */
export function proxyTargetLabel(targetId: string): string {
    const key = TARGET_LABEL_KEYS[targetId];
    return key ? I18nManager.getInstance().t(key) : targetId;
}
