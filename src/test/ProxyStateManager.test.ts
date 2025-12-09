/**
 * Unit tests for ProxyStateManager
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 1.2, 1.3 (Task 5.3)
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState, ProxyTestResult } from '../core/types';

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

    /**
     * Feature: auto-mode-proxy-testing
     * Tests for new connection testing fields
     */
    suite('Connection Testing Fields (auto-mode-proxy-testing)', () => {
        test('saveState should persist connection testing fields', async () => {
            const testResult: ProxyTestResult = {
                success: true,
                testUrls: ['https://example.com', 'https://google.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 150
            };

            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080',
                lastTestResult: testResult,
                proxyReachable: true,
                lastTestTimestamp: Date.now()
            };

            await stateManager.saveState(testState);

            assert.deepStrictEqual(storedState, testState);
            assert.strictEqual(storedState!.lastTestResult!.success, true);
            assert.strictEqual(storedState!.proxyReachable, true);
            assert.ok(storedState!.lastTestTimestamp);
        });

        test('getState should return saved connection testing fields', async () => {
            const testResult: ProxyTestResult = {
                success: false,
                testUrls: ['https://example.com'],
                errors: [{ url: 'https://example.com', message: 'Connection timeout' }],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 3000
            };

            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080',
                lastTestResult: testResult,
                proxyReachable: false,
                lastTestTimestamp: Date.now()
            };

            await stateManager.saveState(testState);
            const retrievedState = await stateManager.getState();

            assert.deepStrictEqual(retrievedState.lastTestResult, testResult);
            assert.strictEqual(retrievedState.proxyReachable, false);
            assert.strictEqual(retrievedState.lastTestTimestamp, testState.lastTestTimestamp);
        });

        test('backward compatibility: old state without new fields should work', async () => {
            // Simulate old state format without new fields
            const oldState = {
                mode: ProxyMode.Manual,
                manualProxyUrl: 'http://proxy.example.com:8080',
                autoProxyUrl: undefined,
                lastSystemProxyCheck: Date.now(),
                gitConfigured: true,
                vscodeConfigured: true,
                npmConfigured: false,
                systemProxyDetected: false,
                lastError: undefined
                // No lastTestResult, proxyReachable, or lastTestTimestamp
            };

            storedState = oldState as ProxyState;
            const retrievedState = await stateManager.getState();

            // Should work without errors and have undefined for new fields
            assert.strictEqual(retrievedState.mode, ProxyMode.Manual);
            assert.strictEqual(retrievedState.manualProxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(retrievedState.lastTestResult, undefined);
            assert.strictEqual(retrievedState.proxyReachable, undefined);
            assert.strictEqual(retrievedState.lastTestTimestamp, undefined);
        });

        test('state with only some new fields should work', async () => {
            const partialState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080',
                proxyReachable: true
                // No lastTestResult or lastTestTimestamp
            };

            await stateManager.saveState(partialState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.proxyReachable, true);
            assert.strictEqual(retrievedState.lastTestResult, undefined);
            assert.strictEqual(retrievedState.lastTestTimestamp, undefined);
        });

        test('test result with errors should be preserved correctly', async () => {
            const testResult: ProxyTestResult = {
                success: false,
                testUrls: ['https://example.com', 'https://google.com', 'https://github.com'],
                errors: [
                    { url: 'https://example.com', message: 'Connection refused' },
                    { url: 'https://google.com', message: 'Timeout' },
                    { url: 'https://github.com', message: 'DNS resolution failed' }
                ],
                proxyUrl: 'http://bad-proxy.example.com:8080',
                timestamp: 1702100000000,
                duration: 3000
            };

            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://bad-proxy.example.com:8080',
                lastTestResult: testResult,
                proxyReachable: false,
                lastTestTimestamp: 1702100000000
            };

            await stateManager.saveState(testState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.lastTestResult!.errors.length, 3);
            assert.strictEqual(retrievedState.lastTestResult!.errors[0].url, 'https://example.com');
            assert.strictEqual(retrievedState.lastTestResult!.errors[0].message, 'Connection refused');
        });
    });

    /**
     * Feature: auto-mode-fallback-improvements
     * Tests for fallback proxy fields
     * Task: 2.3
     */
    suite('Fallback Proxy Fields (auto-mode-fallback-improvements)', () => {
        test('saveState should persist fallback proxy fields', async () => {
            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: undefined,
                manualProxyUrl: 'http://manual.example.com:8080',
                usingFallbackProxy: true,
                autoModeOff: false,
                lastSystemProxyUrl: 'http://system.example.com:8080',
                fallbackProxyUrl: 'http://manual.example.com:8080'
            };

            await stateManager.saveState(testState);

            assert.deepStrictEqual(storedState, testState);
            assert.strictEqual(storedState!.usingFallbackProxy, true);
            assert.strictEqual(storedState!.autoModeOff, false);
            assert.strictEqual(storedState!.lastSystemProxyUrl, 'http://system.example.com:8080');
            assert.strictEqual(storedState!.fallbackProxyUrl, 'http://manual.example.com:8080');
        });

        test('getState should return saved fallback proxy fields', async () => {
            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: undefined,
                usingFallbackProxy: true,
                autoModeOff: false,
                lastSystemProxyUrl: 'http://old-system.example.com:8080',
                fallbackProxyUrl: 'http://fallback.example.com:8080'
            };

            await stateManager.saveState(testState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.usingFallbackProxy, true);
            assert.strictEqual(retrievedState.autoModeOff, false);
            assert.strictEqual(retrievedState.lastSystemProxyUrl, 'http://old-system.example.com:8080');
            assert.strictEqual(retrievedState.fallbackProxyUrl, 'http://fallback.example.com:8080');
        });

        test('Auto Mode OFF state should be saved and retrieved correctly', async () => {
            const testState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: undefined,
                usingFallbackProxy: false,
                autoModeOff: true,
                lastSystemProxyUrl: 'http://last-system.example.com:8080',
                fallbackProxyUrl: undefined
            };

            await stateManager.saveState(testState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.autoModeOff, true);
            assert.strictEqual(retrievedState.usingFallbackProxy, false);
            assert.strictEqual(retrievedState.lastSystemProxyUrl, 'http://last-system.example.com:8080');
            assert.strictEqual(retrievedState.fallbackProxyUrl, undefined);
        });

        test('backward compatibility: old state without fallback fields should work', async () => {
            // Simulate old state format without fallback fields
            const oldState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://auto.example.com:8080',
                manualProxyUrl: 'http://manual.example.com:8080',
                lastSystemProxyCheck: Date.now(),
                gitConfigured: true,
                vscodeConfigured: true,
                systemProxyDetected: true
                // No fallback fields
            };

            storedState = oldState as ProxyState;
            const retrievedState = await stateManager.getState();

            // Should work without errors and have undefined for fallback fields
            assert.strictEqual(retrievedState.mode, ProxyMode.Auto);
            assert.strictEqual(retrievedState.autoProxyUrl, 'http://auto.example.com:8080');
            assert.strictEqual(retrievedState.usingFallbackProxy, undefined);
            assert.strictEqual(retrievedState.autoModeOff, undefined);
            assert.strictEqual(retrievedState.lastSystemProxyUrl, undefined);
            assert.strictEqual(retrievedState.fallbackProxyUrl, undefined);
        });

        test('state with only some fallback fields should work', async () => {
            const partialState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: undefined,
                usingFallbackProxy: true
                // No autoModeOff, lastSystemProxyUrl, or fallbackProxyUrl
            };

            await stateManager.saveState(partialState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.usingFallbackProxy, true);
            assert.strictEqual(retrievedState.autoModeOff, undefined);
            assert.strictEqual(retrievedState.lastSystemProxyUrl, undefined);
            assert.strictEqual(retrievedState.fallbackProxyUrl, undefined);
        });

        test('transition from fallback to system proxy should update state correctly', async () => {
            // Initial state: using fallback
            const fallbackState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://fallback.example.com:8080',
                usingFallbackProxy: true,
                autoModeOff: false,
                fallbackProxyUrl: 'http://fallback.example.com:8080'
            };

            await stateManager.saveState(fallbackState);

            // Transition: system proxy becomes available
            const systemState: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://system.example.com:8080',
                usingFallbackProxy: false,
                autoModeOff: false,
                lastSystemProxyUrl: 'http://system.example.com:8080',
                fallbackProxyUrl: undefined
            };

            await stateManager.saveState(systemState);
            const retrievedState = await stateManager.getState();

            assert.strictEqual(retrievedState.usingFallbackProxy, false);
            assert.strictEqual(retrievedState.autoProxyUrl, 'http://system.example.com:8080');
            assert.strictEqual(retrievedState.fallbackProxyUrl, undefined);
        });
    });
});
