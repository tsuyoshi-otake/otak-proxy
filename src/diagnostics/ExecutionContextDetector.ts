import * as vscode from 'vscode';
import {
    ExecutionContext,
    ExtensionHostLocation,
    UiKind,
    WorkspaceHostKind
} from '../core/v3Types';

/**
 * The inputs the execution context is derived from, read once from vscode.env,
 * the extension and the extension host process. Kept apart from the reading so
 * the derivation can be tested for UI / host combinations that a test host
 * cannot fake, such as a browser UI over a remote Node extension host (#93).
 */
export interface ExecutionEnvironment {
    uiKind: UiKind;
    remoteName?: string;
    extensionKind?: 'ui' | 'workspace';
    /**
     * The extension host runs on Node.js (desktop, or a remote server reached
     * from a browser UI) rather than in a browser web worker.
     */
    nodeExtensionHost: boolean;
    /** The extension host's platform; undefined without Node.js. */
    platform?: string;
    hasWorkspaceFolders: boolean;
}

function getExtensionHostLocation(environment: ExecutionEnvironment): ExtensionHostLocation {
    // Only a web worker extension host is "web". A browser UI (tunnels,
    // Codespaces) still runs this extension in a remote Node extension host:
    // it has no browser entry and declares extensionKind ["workspace"] (#93).
    if (!environment.nodeExtensionHost) {
        return 'web';
    }

    if (environment.extensionKind === 'workspace') {
        return environment.remoteName ? 'remoteWorkspace' : 'localUi';
    }
    if (environment.extensionKind === 'ui') {
        return 'localUi';
    }

    return environment.remoteName ? 'unknown' : 'localUi';
}

function getWorkspaceHostKind(
    extensionHostLocation: ExtensionHostLocation,
    environment: ExecutionEnvironment
): WorkspaceHostKind {
    if (extensionHostLocation === 'web') {
        return 'web';
    }

    const remoteName = environment.remoteName;
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

    return environment.platform === 'win32' ? 'localWindows' : 'localNonWindows';
}

export function deriveExecutionContext(environment: ExecutionEnvironment): ExecutionContext {
    const extensionHostLocation = getExtensionHostLocation(environment);
    const workspaceHostKind = getWorkspaceHostKind(extensionHostLocation, environment);
    const isWeb = extensionHostLocation === 'web';
    // reg.exe / netsh run wherever the extension host process runs on Windows,
    // including a Remote-SSH connection to a Windows host (remoteWorkspace +
    // win32). Gating on localUi skipped WinHTTP/WinINet diagnostics there even
    // though they work; gate on the host actually being Windows instead (#16).
    const runsOnWindowsHost = !isWeb && environment.platform === 'win32';

    return {
        uiKind: environment.uiKind,
        remoteName: environment.remoteName,
        extensionHostLocation,
        workspaceHostKind,
        canUseChildProcess: !isWeb,
        canReadWindowsRegistry: runsOnWindowsHost,
        canWriteVSCodeUserSettings: !isWeb,
        canAccessWorkspaceFiles: !isWeb && environment.hasWorkspaceFolders
    };
}

function readExecutionEnvironment(context?: vscode.ExtensionContext): ExecutionEnvironment {
    const extensionKind = context?.extension?.extensionKind;
    const hostProcess = typeof process === 'undefined' ? undefined : process;
    return {
        uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
        remoteName: vscode.env.remoteName,
        extensionKind: extensionKind === vscode.ExtensionKind.Workspace
            ? 'workspace'
            : extensionKind === vscode.ExtensionKind.UI ? 'ui' : undefined,
        nodeExtensionHost: typeof hostProcess?.versions?.node === 'string',
        platform: hostProcess?.platform,
        hasWorkspaceFolders: Boolean(vscode.workspace.workspaceFolders?.length)
    };
}

export class ExecutionContextDetector {
    constructor(private readonly context?: vscode.ExtensionContext) {}

    detect(): ExecutionContext {
        return deriveExecutionContext(readExecutionEnvironment(this.context));
    }
}
