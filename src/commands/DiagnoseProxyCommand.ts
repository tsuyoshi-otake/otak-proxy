import * as vscode from 'vscode';
import { ProxyState } from '../core/types';
import { getHighestPriorityIssue, type ProxyIssue } from '../core/v3Types';
import { ProxyRuntimeDiagnostics, type ProxyDiagnosticReport } from '../diagnostics/ProxyRuntimeDiagnostics';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { Logger } from '../utils/Logger';

let diagnosticsChannel: vscode.LogOutputChannel | undefined;

function getDiagnosticsChannel(): vscode.LogOutputChannel {
    if (!diagnosticsChannel) {
        diagnosticsChannel = vscode.window.createOutputChannel('Otak Proxy Diagnostics', { log: true });
    }
    return diagnosticsChannel;
}

function targetLabel(issue: ProxyIssue): string {
    const labels: Record<string, string> = {
        'git.global.proxy': 'Git global proxy',
        'git.global.https.proxy': 'Git global https.proxy',
        'git.override': 'Git proxy override',
        'npm.user.proxy': 'npm user proxy',
        'npm.noproxy': 'npm noproxy',
        'vscode.http.proxy': 'VS Code http.proxy',
        'vscode.http.proxySupport': 'VS Code proxy support',
        'vscode.launch.argv': 'VS Code launch proxy flags',
        'terminal.env.inherited': 'Terminal proxy environment',
        'terminal.existing': 'Existing terminals',
        'diagnostics.childProcess': 'Git/npm diagnostics',
        'windows': 'Windows proxy diagnostics'
    };

    return labels[issue.targetId] ?? issue.targetId;
}

function issueReason(issue: ProxyIssue): string {
    if (issue.id.endsWith('.managedProxyResidual')) {
        return 'proxy should be disabled, but a proxy is still configured';
    }
    if (issue.id.endsWith('.managedProxyMismatch')) {
        return 'configured proxy does not match the expected active proxy';
    }
    if (issue.id === 'diagnostics.childProcess.unavailable') {
        return 'Git/npm configuration could not be inspected in this extension host';
    }
    if (issue.id === 'windows.diagnostics.unavailable') {
        return 'Windows proxy state cannot be inspected from this extension host';
    }
    if (issue.id === 'vscode.proxySupport.off') {
        return 'VS Code proxy support is disabled';
    }
    if (issue.id === 'vscode.launch.proxyFlags') {
        return 'VS Code was launched with proxy-related process flags';
    }
    if (issue.id === 'terminal.inheritedProxyEnv') {
        return 'new terminals may inherit proxy environment variables';
    }
    if (issue.id === 'terminal.existingTerminals') {
        return 'existing terminals keep their old proxy environment';
    }
    if (issue.id === 'git.legacyHttpsProxy') {
        return 'legacy Git https.proxy is configured';
    }
    if (issue.id === 'git.effectiveOverride') {
        return 'Git has an effective proxy override';
    }
    if (issue.id === 'npm.noproxy') {
        return 'npm noproxy is configured and may bypass the proxy';
    }

    return issue.id;
}

export function formatDiagnosticsNotification(report: Pick<ProxyDiagnosticReport, 'issueCount' | 'issues'>): string {
    if (report.issueCount === 0) {
        return 'Proxy diagnostics completed: no issues found.';
    }

    const issueCountLabel = report.issueCount === 1 ? '1 issue' : `${report.issueCount} issues`;
    const primaryIssue = getHighestPriorityIssue(report.issues) ?? report.issues[0];
    if (!primaryIssue) {
        return `Proxy diagnostics found ${issueCountLabel}. See Otak Proxy Diagnostics for details.`;
    }

    const extraCount = Math.max(0, report.issueCount - 1);
    const extraSuffix = extraCount > 0 ? ` (+${extraCount} more)` : '';
    return `Proxy diagnostics found ${issueCountLabel}: ${targetLabel(primaryIssue)} - ${issueReason(primaryIssue)}${extraSuffix}. See Otak Proxy Diagnostics for details.`;
}

export async function executeDiagnoseProxy(
    context: vscode.ExtensionContext,
    getProxyState: () => Promise<ProxyState>
): Promise<void> {
    const redactor = new ProxySecretRedactor();
    try {
        const diagnostics = new ProxyRuntimeDiagnostics(context, getProxyState);
        const report = await diagnostics.run();
        const channel = getDiagnosticsChannel();
        channel.info(`Proxy diagnostics generated at ${report.generatedAt}`);
        channel.info(JSON.stringify(redactor.redactValue(report), null, 2));
        channel.show();
        void vscode.window.showInformationMessage(
            formatDiagnosticsNotification(report),
            'OK'
        );
    } catch (error) {
        const message = redactor.redactString(error instanceof Error ? error.message : String(error));
        Logger.error('Proxy diagnostics failed:', message);
        void vscode.window.showErrorMessage(`Proxy diagnostics failed: ${message}`);
    }
}
