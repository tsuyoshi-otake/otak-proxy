import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { readWindowsProxyEnvironment, WindowsProxyEnvironmentMonitor } from './WindowsProxyEnvironment';

export function startWindowsProxyEnvironmentNotification(
    read = readWindowsProxyEnvironment
): WindowsProxyEnvironmentMonitor | undefined {
    if (process.platform !== 'win32' || vscode.env.remoteName) {
        return undefined;
    }
    const monitor = new WindowsProxyEnvironmentMonitor({
        read,
        isFocused: () => vscode.window.state.focused,
        canNotify: () => vscode.workspace.getConfiguration('otakProxy').get<string>('notificationLevel', 'warnings') !== 'off',
        notify: names => {
            const message = I18nManager.getInstance().t('warning.proxyEnvironmentRestart', { names: names.join(', ') });
            // Dismissal is user-owned and must not hold the polling lifecycle open.
            void Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => undefined);
        }
    });
    monitor.start();
    return monitor;
}
