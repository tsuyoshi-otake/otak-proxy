import * as vscode from 'vscode';
import { ProxyState } from '../core/types';
import { getHighestPriorityIssue, type ProxyIssue } from '../core/v3Types';
import { ProxyRuntimeDiagnostics, type ProxyDiagnosticReport } from '../diagnostics/ProxyRuntimeDiagnostics';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';

let diagnosticsChannel: vscode.LogOutputChannel | undefined;

function getDiagnosticsChannel(): vscode.LogOutputChannel {
    if (!diagnosticsChannel) {
        diagnosticsChannel = vscode.window.createOutputChannel('Otak Proxy Diagnostics', { log: true });
    }
    return diagnosticsChannel;
}

// Maps a diagnostic targetId to its localized label key. Kept as data (not inline
// strings) so every target is localized through the locale files (issue #13).
const TARGET_LABEL_KEYS: Record<string, string> = {
    'git.global.proxy': 'diagnose.target.gitGlobalProxy',
    'git.global.https.proxy': 'diagnose.target.gitGlobalHttpsProxy',
    'git.override': 'diagnose.target.gitOverride',
    'npm.user.proxy': 'diagnose.target.npmUserProxy',
    'npm.noproxy': 'diagnose.target.npmNoproxy',
    'vscode.http.proxy': 'diagnose.target.vscodeHttpProxy',
    'vscode.http.proxySupport': 'diagnose.target.vscodeHttpProxySupport',
    'vscode.launch.argv': 'diagnose.target.vscodeLaunchArgv',
    'terminal.env.inherited': 'diagnose.target.terminalEnvInherited',
    'terminal.existing': 'diagnose.target.terminalExisting',
    'diagnostics.childProcess': 'diagnose.target.diagnosticsChildProcess',
    'windows': 'diagnose.target.windows',
    'windows.winhttp': 'diagnose.target.windowsWinhttp',
    'windows.wininet': 'diagnose.target.windowsWininet'
};

function targetLabel(issue: ProxyIssue): string {
    const key = TARGET_LABEL_KEYS[issue.targetId];
    return key ? I18nManager.getInstance().t(key) : issue.targetId;
}

function issueReasonKey(issue: ProxyIssue): string | undefined {
    if (issue.id.endsWith('.managedProxyResidual')) {
        return 'diagnose.reason.managedProxyResidual';
    }
    if (issue.id.endsWith('.managedProxyMismatch')) {
        return 'diagnose.reason.managedProxyMismatch';
    }
    switch (issue.id) {
        case 'diagnostics.childProcess.unavailable':
            return 'diagnose.reason.childProcessUnavailable';
        case 'windows.diagnostics.unavailable':
            return 'diagnose.reason.windowsUnavailable';
        case 'windows.winhttp.parseUnavailable':
            return 'diagnose.reason.winhttpParseUnavailable';
        case 'windows.wininet.pac':
            return 'diagnose.reason.wininetPac';
        case 'git.readUnavailable':
            return 'diagnose.reason.gitReadUnavailable';
        case 'vscode.proxySupport.off':
            return 'diagnose.reason.proxySupportOff';
        case 'vscode.launch.proxyFlags':
            return 'diagnose.reason.launchProxyFlags';
        case 'terminal.inheritedProxyEnv':
            return 'diagnose.reason.inheritedProxyEnv';
        case 'terminal.existingTerminals':
            return 'diagnose.reason.existingTerminals';
        case 'git.legacyHttpsProxy':
            return 'diagnose.reason.legacyHttpsProxy';
        case 'git.effectiveOverride':
            return 'diagnose.reason.effectiveOverride';
        case 'npm.noproxy':
            return 'diagnose.reason.npmNoproxy';
        default:
            return undefined;
    }
}

function issueReason(issue: ProxyIssue): string {
    const key = issueReasonKey(issue);
    return key ? I18nManager.getInstance().t(key) : issue.id;
}

export function formatDiagnosticsNotification(report: Pick<ProxyDiagnosticReport, 'issueCount' | 'issues'>): string {
    const i18n = I18nManager.getInstance();
    if (report.issueCount === 0) {
        return i18n.t('diagnose.noIssues');
    }

    const issuesLabel = report.issueCount === 1
        ? i18n.t('diagnose.issueCountOne')
        : i18n.t('diagnose.issueCountMany', { count: String(report.issueCount) });
    const primaryIssue = getHighestPriorityIssue(report.issues) ?? report.issues[0];
    if (!primaryIssue) {
        return i18n.t('diagnose.summaryNoPrimary', { issues: issuesLabel });
    }

    const extraCount = Math.max(0, report.issueCount - 1);
    const extra = extraCount > 0 ? i18n.t('diagnose.extraMore', { count: String(extraCount) }) : '';
    return i18n.t('diagnose.summary', {
        issues: issuesLabel,
        label: targetLabel(primaryIssue),
        reason: issueReason(primaryIssue),
        extra
    });
}

export async function executeDiagnoseProxy(
    context: vscode.ExtensionContext,
    getProxyState: () => Promise<ProxyState>
): Promise<void> {
    const i18n = I18nManager.getInstance();
    const redactor = new ProxySecretRedactor();
    try {
        const diagnostics = new ProxyRuntimeDiagnostics(context, getProxyState);
        // A user-invoked diagnosis should read fresh state, not a slow-diagnostics
        // cache entry up to slowDiagnosticsTtlMs (default 5 min) old (#16).
        const report = await diagnostics.run({ bypassSlowCache: true });
        const channel = getDiagnosticsChannel();
        channel.info(i18n.t('diagnose.generatedAt', { timestamp: String(report.generatedAt) }));
        channel.info(JSON.stringify(redactor.redactValue(report), null, 2));
        channel.show();
        void vscode.window.showInformationMessage(
            formatDiagnosticsNotification(report),
            i18n.t('action.ok')
        );
    } catch (error) {
        const message = redactor.redactString(error instanceof Error ? error.message : String(error));
        Logger.error('Proxy diagnostics failed:', message);
        void vscode.window.showErrorMessage(i18n.t('diagnose.failed', { message }));
    }
}
