/**
 * Property-based tests for ProxyStateManager
 * **Feature: extension-refactoring**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../core/types';
import { getPropertyTestRuns } from './helpers';

suite('ProxyStateManager Property Tests', () => {
    let context: vscode.ExtensionContext;
    let stateManager: ProxyStateManager;

    setup(() => {
        // Create a mock extension context
        context = {
            globalState: {
                get: (key: string, defaultValue?: any) => defaultValue,
                update: async (key: string, value: any) => {
                    // Simulate successful update
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

    /**
     * **Property 3: State persistence fallback**
     * **Validates: Requirements 3.2**
     *
     * For any ProxyState, when globalState.update fails, the system should
     * automatically use in-memory fallback and notify the user
     */
    test('Property 3: State persistence fallback - globalState.update failure triggers in-memory fallback', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                // Generate random ProxyState
                fc.record({
                    mode: fc.constantFrom(ProxyMode.Off, ProxyMode.Manual, ProxyMode.Auto),
                    manualProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
                    autoProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
                    lastSystemProxyCheck: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
                    gitConfigured: fc.option(fc.boolean(), { nil: undefined }),
                    vscodeConfigured: fc.option(fc.boolean(), { nil: undefined }),
                    npmConfigured: fc.option(fc.boolean(), { nil: undefined }),
                    systemProxyDetected: fc.option(fc.boolean(), { nil: undefined }),
                    lastError: fc.option(fc.string(), { nil: undefined })
                }),
                async (state: ProxyState) => {
                    // Create a context where globalState.update fails
                    const failingContext = {
                        ...context,
                        globalState: {
                            ...context.globalState,
                            update: async (key: string, value: any) => {
                                throw new Error('Simulated storage failure');
                            }
                        }
                    } as unknown as vscode.ExtensionContext;

                    const failingStateManager = new ProxyStateManager(failingContext);

                    // Save state (should fail and use in-memory fallback)
                    await failingStateManager.saveState(state);

                    // Retrieve state (should return in-memory fallback)
                    const retrievedState = await failingStateManager.getState();

                    // Verify that the retrieved state matches the saved state
                    assert.strictEqual(retrievedState.mode, state.mode);
                    assert.strictEqual(retrievedState.manualProxyUrl, state.manualProxyUrl);
                    assert.strictEqual(retrievedState.autoProxyUrl, state.autoProxyUrl);
                    assert.strictEqual(retrievedState.lastSystemProxyCheck, state.lastSystemProxyCheck);
                    assert.strictEqual(retrievedState.gitConfigured, state.gitConfigured);
                    assert.strictEqual(retrievedState.vscodeConfigured, state.vscodeConfigured);
                    assert.strictEqual(retrievedState.npmConfigured, state.npmConfigured);
                    assert.strictEqual(retrievedState.systemProxyDetected, state.systemProxyDetected);
                    assert.strictEqual(retrievedState.lastError, state.lastError);
                }
            ),
            { numRuns }
        );
    });

    /**
     * **Property 4: Legacy state migration**
     * **Validates: Requirements 3.3**
     *
     * For any old format state data, reading the state should transparently
     * migrate it to the new format without data loss
     */
    test('Property 4: Legacy state migration - old settings are migrated to new format', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                // Generate random old settings
                fc.boolean(), // oldEnabled
                fc.option(fc.webUrl(), { nil: '' }), // manualUrl
                async (oldEnabled: boolean, manualUrl: string) => {
                    // Create a context with old settings
                    const migrationContext = {
                        ...context,
                        globalState: {
                            get: (key: string, defaultValue?: any) => {
                                if (key === 'proxyState') {
                                    return undefined; // No new state exists
                                }
                                if (key === 'proxyEnabled') {
                                    return oldEnabled;
                                }
                                return defaultValue;
                            },
                            update: async (key: string, value: any) => {
                                // Simulate successful update
                            },
                            keys: () => [],
                            setKeysForSync: () => {}
                        },
                        workspaceState: {} as any
                    } as unknown as vscode.ExtensionContext;

                    // Mock workspace configuration
                    const originalGetConfiguration = vscode.workspace.getConfiguration;
                    (vscode.workspace as any).getConfiguration = (section?: string) => {
                        if (section === 'otakProxy') {
                            return {
                                get: (key: string, defaultValue?: any) => {
                                    if (key === 'proxyUrl') {
                                        return manualUrl;
                                    }
                                    return defaultValue;
                                }
                            };
                        }
                        return originalGetConfiguration(section);
                    };

                    try {
                        const migrationStateManager = new ProxyStateManager(migrationContext);

                        // Get state (should trigger migration)
                        const migratedState = await migrationStateManager.getState();

                        // Verify migration
                        if (oldEnabled && manualUrl) {
                            assert.strictEqual(migratedState.mode, ProxyMode.Manual);
                            assert.strictEqual(migratedState.manualProxyUrl, manualUrl);
                        } else {
                            assert.strictEqual(migratedState.mode, ProxyMode.Off);
                        }

                        // Verify other fields are initialized
                        assert.strictEqual(migratedState.autoProxyUrl, undefined);
                        assert.strictEqual(migratedState.lastSystemProxyCheck, undefined);
                        assert.strictEqual(migratedState.gitConfigured, undefined);
                        assert.strictEqual(migratedState.vscodeConfigured, undefined);
                        assert.strictEqual(migratedState.npmConfigured, undefined);
                        assert.strictEqual(migratedState.systemProxyDetected, undefined);
                        assert.strictEqual(migratedState.lastError, undefined);
                    } finally {
                        // Restore original getConfiguration
                        (vscode.workspace as any).getConfiguration = originalGetConfiguration;
                    }
                }
            ),
            { numRuns }
        );
    });
});
