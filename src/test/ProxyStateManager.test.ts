/**
 * Unit tests for ProxyStateManager
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../core/types';

suite('ProxyStateManager Unit Tests', () => {
    let context: vscode.ExtensionContext;
    let stateManager: ProxyStateManager;
    let storedState: ProxyState | undefined;

    setup(() => {
        storedState = undefined;

        // Create a mock extension context
        context = {
            globalState: {
                get: (key: string, defaultValue?: any) => {
                    if (key === 'proxyState') {
                        return storedState;
                    }
                    return defaultValue;
                },
                update: async (key: string, value: any) => {
                    if (key === 'proxyState') {
                        storedState = value;
                    }
                },
                keys: () => [],
                setKeysForSync: () => {}
            },
            subscriptions: [],
            extensionPath: '',
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            extensionUri: vscode.Uri.file(''),
            environmentVariableCollection: {} as any,
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            asAbsolutePath: (relativePath: string) => relativePath,
            workspaceState: {} as any,
            secrets: {} as any,
            extension: {} as any,
            languageModelAccessInformation: {} as any
        } as unknown as vscode.ExtensionContext;

        stateManager = new ProxyStateManager(context);
    });

    test('getState should return default state when no state exists', async () => {
        // Mock workspace configuration
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        (vscode.workspace as any).getConfiguration = (section?: string) => {
            if (section === 'otakProxy') {
                return {
                    get: (key: string, defaultValue?: any) => defaultValue
                };
            }
            return originalGetConfiguration(section);
        };

        try {
            const state = await stateManager.getState();

            assert.strictEqual(state.mode, ProxyMode.Off);
            assert.strictEqual(state.manualProxyUrl, '');
            assert.strictEqual(state.autoProxyUrl, undefined);
        } finally {
            (vscode.workspace as any).getConfiguration = originalGetConfiguration;
        }
    });

    test('saveState should persist state to globalState', async () => {
        const testState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://proxy.example.com:8080',
            autoProxyUrl: undefined,
            lastSystemProxyCheck: Date.now(),
            gitConfigured: true,
            vscodeConfigured: true,
            npmConfigured: false,
            systemProxyDetected: false,
            lastError: undefined
        };

        await stateManager.saveState(testState);

        // Verify state was stored
        assert.deepStrictEqual(storedState, testState);
    });

    test('getState should return saved state', async () => {
        const testState: ProxyState = {
            mode: ProxyMode.Auto,
            manualProxyUrl: undefined,
            autoProxyUrl: 'http://auto-proxy.example.com:8080',
            lastSystemProxyCheck: Date.now(),
            gitConfigured: false,
            vscodeConfigured: true,
            npmConfigured: true,
            systemProxyDetected: true,
            lastError: undefined
        };

        await stateManager.saveState(testState);
        const retrievedState = await stateManager.getState();

        assert.deepStrictEqual(retrievedState, testState);
    });

    test('getActiveProxyUrl should return correct URL based on mode', () => {
        const manualState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: 'http://manual.example.com:8080',
            autoProxyUrl: 'http://auto.example.com:8080'
        };

        const autoState: ProxyState = {
            mode: ProxyMode.Auto,
            manualProxyUrl: 'http://manual.example.com:8080',
            autoProxyUrl: 'http://auto.example.com:8080'
        };

        const offState: ProxyState = {
            mode: ProxyMode.Off,
            manualProxyUrl: 'http://manual.example.com:8080',
            autoProxyUrl: 'http://auto.example.com:8080'
        };

        assert.strictEqual(
            stateManager.getActiveProxyUrl(manualState),
            'http://manual.example.com:8080'
        );
        assert.strictEqual(
            stateManager.getActiveProxyUrl(autoState),
            'http://auto.example.com:8080'
        );
        assert.strictEqual(
            stateManager.getActiveProxyUrl(offState),
            ''
        );
    });

    test('getNextMode should cycle through modes correctly', () => {
        assert.strictEqual(stateManager.getNextMode(ProxyMode.Off), ProxyMode.Manual);
        assert.strictEqual(stateManager.getNextMode(ProxyMode.Manual), ProxyMode.Auto);
        assert.strictEqual(stateManager.getNextMode(ProxyMode.Auto), ProxyMode.Off);
    });

    test('getActiveProxyUrl should return empty string when URL is undefined', () => {
        const manualState: ProxyState = {
            mode: ProxyMode.Manual,
            manualProxyUrl: undefined
        };

        const autoState: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: undefined
        };

        assert.strictEqual(stateManager.getActiveProxyUrl(manualState), '');
        assert.strictEqual(stateManager.getActiveProxyUrl(autoState), '');
    });
});
