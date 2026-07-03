import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { readV3Settings } from '../core/V3Settings';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { Logger } from '../utils/Logger';

const execFileAsync = promisify(execFile);

export type WindowsActionRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsActionResult {
    success: boolean;
    skippedReason?: 'notWindows' | 'disabled' | 'cancelled';
    errorSanitized?: string;
}

const defaultRunner: WindowsActionRunner = async (command, args) => execFileAsync(command, args, {
    timeout: 10000,
    encoding: 'utf8',
    windowsHide: true
});

export class WindowsProxyActionService {
    private readonly redactor = new ProxySecretRedactor();

    constructor(private readonly runner: WindowsActionRunner = defaultRunner) {}

    async resetWinHttpProxy(): Promise<WindowsActionResult> {
        const i18n = I18nManager.getInstance();
        if (process.platform !== 'win32') {
            void vscode.window.showInformationMessage(i18n.t('windowsAction.notWindows'));
            return { success: false, skippedReason: 'notWindows' };
        }

        if (!readV3Settings().windowsActionsEnabled) {
            void vscode.window.showWarningMessage(i18n.t('windowsAction.disabled'));
            return { success: false, skippedReason: 'disabled' };
        }

        const approve = i18n.t('action.resetWinHttpProxy');
        const cancel = i18n.t('action.cancel');
        const action = await vscode.window.showWarningMessage(
            i18n.t('windowsAction.resetWinHttpConfirm'),
            { modal: true },
            approve,
            cancel
        );

        if (action !== approve) {
            return { success: false, skippedReason: 'cancelled' };
        }

        try {
            await this.runner('netsh', ['winhttp', 'reset', 'proxy']);
            void vscode.window.showInformationMessage(i18n.t('windowsAction.resetWinHttpSuccess'));
            return { success: true };
        } catch (error) {
            const message = this.redactor.redactString(error instanceof Error ? error.message : String(error));
            Logger.warn('WinHTTP proxy reset failed:', message);
            void vscode.window.showErrorMessage(i18n.t('windowsAction.resetWinHttpFailed', { error: message }));
            return { success: false, errorSanitized: message };
        }
    }
}

export async function executeResetWinHttpProxy(): Promise<void> {
    await new WindowsProxyActionService().resetWinHttpProxy();
}
