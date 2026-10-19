import * as assert from 'assert';
import { ExecutionEnvironment, deriveExecutionContext } from '../../diagnostics/ExecutionContextDetector';

/**
 * #93 item 5: a browser UI (uiKind Web) over a remote Node extension host was
 * treated as a web worker host, so every child_process / registry check was
 * disabled and the workspace host was reported as "web". Capabilities now
 * follow the extension host runtime; uiKind is still reported as it is.
 *
 * These cases fake the environment; a real browser UI + remote host has not
 * been exercised.
 */
suite('ExecutionContextDetector (#93)', () => {
    const environment = (overrides: Partial<ExecutionEnvironment>): ExecutionEnvironment => ({
        uiKind: 'desktop',
        extensionKind: 'workspace',
        nodeExtensionHost: true,
        platform: 'linux',
        hasWorkspaceFolders: true,
        ...overrides
    });

    test('a browser UI over a remote Node extension host keeps the host capabilities', () => {
        const context = deriveExecutionContext(environment({ uiKind: 'web', remoteName: 'codespaces' }));

        assert.strictEqual(context.uiKind, 'web', 'the UI kind is still reported');
        assert.strictEqual(context.remoteName, 'codespaces');
        assert.strictEqual(context.extensionHostLocation, 'remoteWorkspace');
        assert.strictEqual(context.workspaceHostKind, 'codespaces');
        assert.strictEqual(context.canUseChildProcess, true);
        assert.strictEqual(context.canWriteVSCodeUserSettings, false, 'a remote window never writes http.proxy (#108)');
        assert.strictEqual(context.canAccessWorkspaceFiles, true);
        assert.strictEqual(context.canReadWindowsRegistry, false, 'a Linux host has no registry');
    });

    test('the workspace host kind follows remoteName under a browser UI', () => {
        const kinds: Array<[string, string]> = [
            ['ssh-remote', 'ssh'],
            ['wsl', 'wsl'],
            ['dev-container', 'devContainer'],
            ['tunnel', 'unknown']
        ];
        for (const [remoteName, expected] of kinds) {
            const context = deriveExecutionContext(environment({ uiKind: 'web', remoteName }));
            assert.strictEqual(context.workspaceHostKind, expected, remoteName);
            assert.strictEqual(context.canUseChildProcess, true, remoteName);
        }
    });

    test('a browser UI over a remote Windows host can still read the registry', () => {
        const context = deriveExecutionContext(environment({ uiKind: 'web', remoteName: 'ssh-remote', platform: 'win32' }));

        assert.strictEqual(context.canReadWindowsRegistry, true);
        assert.strictEqual(context.canUseChildProcess, true);
    });

    test('a web worker extension host is still "web" with no Node capabilities', () => {
        const context = deriveExecutionContext(environment({ uiKind: 'web', nodeExtensionHost: false, platform: undefined }));

        assert.strictEqual(context.extensionHostLocation, 'web');
        assert.strictEqual(context.workspaceHostKind, 'web');
        assert.strictEqual(context.canUseChildProcess, false);
        assert.strictEqual(context.canReadWindowsRegistry, false);
        assert.strictEqual(context.canWriteVSCodeUserSettings, false);
        assert.strictEqual(context.canAccessWorkspaceFiles, false);
    });

    test('only a local window may write the VS Code user setting http.proxy (#108)', () => {
        // The one copy of the rule: VS Code routes a Global write from a remote
        // extension host by how http.proxy is registered in that window, so a
        // remote window writes nothing.
        assert.strictEqual(deriveExecutionContext(environment({})).canWriteVSCodeUserSettings, true, 'local desktop');
        assert.strictEqual(
            deriveExecutionContext(environment({ platform: 'win32' })).canWriteVSCodeUserSettings,
            true,
            'local Windows'
        );
        for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'attached-container', 'codespaces', 'tunnel']) {
            assert.strictEqual(
                deriveExecutionContext(environment({ remoteName })).canWriteVSCodeUserSettings,
                false,
                `${remoteName}, desktop UI`
            );
            assert.strictEqual(
                deriveExecutionContext(environment({ uiKind: 'web', remoteName })).canWriteVSCodeUserSettings,
                false,
                `${remoteName}, browser UI`
            );
        }
        assert.strictEqual(
            deriveExecutionContext(environment({ uiKind: 'web', nodeExtensionHost: false, platform: undefined }))
                .canWriteVSCodeUserSettings,
            false,
            'web worker extension host'
        );
    });

    test('desktop contexts are unchanged', () => {
        const local = deriveExecutionContext(environment({ platform: 'win32' }));
        assert.strictEqual(local.uiKind, 'desktop');
        assert.strictEqual(local.extensionHostLocation, 'localUi');
        assert.strictEqual(local.workspaceHostKind, 'localWindows');
        assert.strictEqual(local.canReadWindowsRegistry, true);

        const remote = deriveExecutionContext(environment({ remoteName: 'ssh-remote' }));
        assert.strictEqual(remote.extensionHostLocation, 'remoteWorkspace');
        assert.strictEqual(remote.workspaceHostKind, 'ssh');

        const noFolders = deriveExecutionContext(environment({ hasWorkspaceFolders: false }));
        assert.strictEqual(noFolders.canAccessWorkspaceFiles, false);
        assert.strictEqual(noFolders.canUseChildProcess, true);
    });
});
