/**
 * In-memory ExtensionContext + ProxyStateManager harness (#108).
 *
 * Shared by the host-lane suites that need the real persist -> strip ->
 * hydrate round trip through SecretStorage (ConfigureUrlCommand,
 * CommandRegistry, ProxyStateManager) instead of a copied stub.
 */
import type * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyState } from '../core/types';

/**
 * A WorkspaceConfiguration backed by a settings map, so the
 * `vscode.workspace.getConfiguration` stub of a suite can serve it and the
 * test can inspect what production code read or rewrote.
 */
export function workspaceConfigurationFromSettings(
    settings: Map<string, string>
): vscode.WorkspaceConfiguration {
    return {
        get: (key: string, defaultValue?: unknown) => settings.get(key) ?? defaultValue,
        update: async (key: string, value: unknown) => { settings.set(key, String(value)); },
        has: () => true,
        inspect: () => undefined
    } as unknown as vscode.WorkspaceConfiguration;
}

export interface RealStateManagerHarness {
    extensionContext: vscode.ExtensionContext;
    manager: ProxyStateManager;
    /** The `otakProxy` settings the bound configuration serves/records. */
    settings: Map<string, string>;
    /** SecretStorage contents, keyed by credential key. */
    secrets: Map<string, string>;
    /** The sanitized proxyState persisted to globalState. */
    persistedState: () => ProxyState | undefined;
    /** A fresh manager over the same context, like a window reload. */
    reload: () => Promise<ProxyState>;
}

/**
 * @param bindConfiguration wires the suite's getConfiguration stub (or a
 *        direct `vscode.workspace.getConfiguration` override) so a lookup of
 *        the `otakProxy` section returns the harness settings. Other sections
 *        are served by the same map.
 */
export function createRealStateManager(
    bindConfiguration?: (config: vscode.WorkspaceConfiguration) => void
): RealStateManagerHarness {
    // Production globalState keeps every key, so the v3 migration journal
    // completes on the first getState() and later reads go through the
    // hydration branch — not through the migration (#108).
    const globalStateData = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    const extensionContext = {
        globalState: {
            get: (key: string, defaultValue?: unknown) =>
                globalStateData.has(key) ? globalStateData.get(key) : defaultValue,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    globalStateData.delete(key);
                } else {
                    globalStateData.set(key, value);
                }
            },
            keys: () => [...globalStateData.keys()] as readonly string[],
            setKeysForSync: () => {}
        },
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        },
        subscriptions: [] as { dispose(): void }[]
    } as unknown as vscode.ExtensionContext;

    const settings = new Map<string, string>();
    bindConfiguration?.(workspaceConfigurationFromSettings(settings));

    return {
        extensionContext,
        manager: new ProxyStateManager(extensionContext),
        settings,
        secrets,
        persistedState: () => globalStateData.get('proxyState') as ProxyState | undefined,
        reload: async () => new ProxyStateManager(extensionContext).getState()
    };
}
