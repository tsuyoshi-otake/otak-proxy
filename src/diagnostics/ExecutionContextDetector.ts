import * as vscode from 'vscode';
import {
    ExecutionContext,
    ExtensionHostLocation,
    WorkspaceHostKind
} from '../core/v3Types';

function getExtensionHostLocation(context?: vscode.ExtensionContext): ExtensionHostLocation {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
        return 'web';
    }

    const extensionKind = context?.extension?.extensionKind;
    if (extensionKind === vscode.ExtensionKind.Workspace) {
        return vscode.env.remoteName ? 'remoteWorkspace' : 'localUi';
    }
    if (extensionKind === vscode.ExtensionKind.UI) {
        return 'localUi';
    }

    return vscode.env.remoteName ? 'unknown' : 'localUi';
}

function getWorkspaceHostKind(extensionHostLocation: ExtensionHostLocation): WorkspaceHostKind {
    if (extensionHostLocation === 'web') {
        return 'web';
    }

    const remoteName = vscode.env.remoteName;
    if (remoteName) {
        if (remoteName === 'wsl') {
            return 'wsl';
        }
        if (remoteName === 'ssh-remote') {
            return 'ssh';
        }
        if (remoteName === 'dev-container' || remoteName === 'attached-container') {
            return 'devContainer';
        }
        if (remoteName === 'codespaces') {
            return 'codespaces';
        }
        return 'unknown';
    }

    return process.platform === 'win32' ? 'localWindows' : 'localNonWindows';
}

export class ExecutionContextDetector {
    constructor(private readonly context?: vscode.ExtensionContext) {}

    detect(): ExecutionContext {
        const extensionHostLocation = getExtensionHostLocation(this.context);
        const workspaceHostKind = getWorkspaceHostKind(extensionHostLocation);
        const isWeb = extensionHostLocation === 'web';
        const runsInLocalWindowsHost = extensionHostLocation === 'localUi' && process.platform === 'win32';

        return {
            uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
            remoteName: vscode.env.remoteName,
            extensionHostLocation,
            workspaceHostKind,
            canUseChildProcess: !isWeb,
            canReadWindowsRegistry: runsInLocalWindowsHost,
            canWriteVSCodeUserSettings: !isWeb,
            canAccessWorkspaceFiles: !isWeb && Boolean(vscode.workspace.workspaceFolders?.length)
        };
    }
}
