import * as vscode from 'vscode';
import { ProxyState } from '../core/types';
import { ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { Logger } from '../utils/Logger';

let diagnosticsChannel: vscode.LogOutputChannel | undefined;

function getDiagnosticsChannel(): vscode.LogOutputChannel {
    if (!diagnosticsChannel) {
        diagnosticsChannel = vscode.window.createOutputChannel('Otak Proxy Diagnostics', { log: true });
    }
    return diagnosticsChannel;
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
            `Proxy diagnostics completed (${report.issueCount} issues).`,
            'OK'
        );
    } catch (error) {
        const message = redactor.redactString(error instanceof Error ? error.message : String(error));
        Logger.error('Proxy diagnostics failed:', message);
        void vscode.window.showErrorMessage(`Proxy diagnostics failed: ${message}`);
    }
}
