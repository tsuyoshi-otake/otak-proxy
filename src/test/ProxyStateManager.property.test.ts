/**
 * Property-based tests for ProxyStateManager
 * **Feature: extension-refactoring**
 * **Feature: auto-mode-fallback-improvements (Task 2.4)**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../core/types';
import { getPropertyTestRuns } from './helpers';
import { proxyUrlArb } from './generators';

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

    /**
     * Feature: auto-mode-fallback-improvements
     * Property 7: Auto Mode OFF state management
     * Task: 2.4
     * Validates: Requirements 3.1
     *
     * For any Auto mode proxy disabled state, the state should be recorded
     * as "Auto Mode OFF" (autoModeOff = true).
     */
    suite('Property 7: Auto Mode OFF state management (Task 2.4)', () => {
        let storedState: ProxyState | undefined;

        setup(() => {
            storedState = undefined;
            // Create a context that properly stores and retrieves state
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

        test('should correctly save and retrieve autoModeOff state', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate random autoModeOff state
                    fc.boolean(),
                    // Generate optional last system proxy URL
                    fc.option(proxyUrlArb, { nil: undefined }),
                    async (autoModeOff, lastSystemProxyUrl) => {
                        // Create state with autoModeOff
                        const testState: ProxyState = {
                            mode: ProxyMode.Auto,
                            autoProxyUrl: autoModeOff ? undefined : lastSystemProxyUrl,
                            autoModeOff,
                            lastSystemProxyUrl,
                            usingFallbackProxy: false
                        };

                        // Save state
                        await stateManager.saveState(testState);

                        // Retrieve state
                        const retrievedState = await stateManager.getState();

                        // Verify autoModeOff is correctly saved and retrieved
                        assert.strictEqual(retrievedState.autoModeOff, autoModeOff,
                            `autoModeOff should be ${autoModeOff}`);

                        // When autoModeOff is true, mode should still be Auto
                        assert.strictEqual(retrievedState.mode, ProxyMode.Auto,
                            'Mode should be Auto when autoModeOff is set');

                        // lastSystemProxyUrl should be preserved
                        assert.strictEqual(retrievedState.lastSystemProxyUrl, lastSystemProxyUrl,
                            'lastSystemProxyUrl should be preserved');
                    }
                ),
                { numRuns }
            );
        });

        test('should distinguish Auto Mode OFF from complete OFF mode', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate random proxy URL for testing
                    fc.option(proxyUrlArb, { nil: undefined }),
                    async (proxyUrl) => {
                        // Test Auto Mode OFF (mode=Auto, autoModeOff=true)
                        const autoModeOffState: ProxyState = {
                            mode: ProxyMode.Auto,
                            autoProxyUrl: undefined,
                            autoModeOff: true,
                            lastSystemProxyUrl: proxyUrl
                        };

                        await stateManager.saveState(autoModeOffState);
                        const retrievedAutoModeOff = await stateManager.getState();

                        // Test complete OFF mode (mode=Off)
                        const completeOffState: ProxyState = {
                            mode: ProxyMode.Off,
                            autoModeOff: false
                        };

                        await stateManager.saveState(completeOffState);
                        const retrievedCompleteOff = await stateManager.getState();

                        // Verify they are distinct
                        assert.strictEqual(retrievedAutoModeOff.mode, ProxyMode.Auto,
                            'Auto Mode OFF should have mode=Auto');
                        assert.strictEqual(retrievedAutoModeOff.autoModeOff, true,
                            'Auto Mode OFF should have autoModeOff=true');

                        assert.strictEqual(retrievedCompleteOff.mode, ProxyMode.Off,
                            'Complete OFF should have mode=Off');
                        assert.strictEqual(retrievedCompleteOff.autoModeOff, false,
                            'Complete OFF should have autoModeOff=false');
                    }
                ),
                { numRuns }
            );
        });

        test('should preserve autoModeOff through multiple state transitions', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate random sequence of state transitions
                    fc.array(
                        fc.record({
                            autoModeOff: fc.boolean(),
                            lastSystemProxyUrl: fc.option(proxyUrlArb, { nil: undefined }),
                            fallbackProxyUrl: fc.option(proxyUrlArb, { nil: undefined }),
                            usingFallbackProxy: fc.boolean()
                        }),
                        { minLength: 1, maxLength: 5 }
                    ),
                    async (transitions) => {
                        for (const transition of transitions) {
                            const testState: ProxyState = {
                                mode: ProxyMode.Auto,
                                autoProxyUrl: transition.autoModeOff ? undefined : transition.lastSystemProxyUrl,
                                autoModeOff: transition.autoModeOff,
                                lastSystemProxyUrl: transition.lastSystemProxyUrl,
                                fallbackProxyUrl: transition.fallbackProxyUrl,
                                usingFallbackProxy: transition.usingFallbackProxy
                            };

                            await stateManager.saveState(testState);
                            const retrievedState = await stateManager.getState();

                            // Verify state is preserved correctly
                            assert.strictEqual(retrievedState.autoModeOff, transition.autoModeOff,
                                'autoModeOff should be preserved');
                            assert.strictEqual(retrievedState.usingFallbackProxy, transition.usingFallbackProxy,
                                'usingFallbackProxy should be preserved');
                        }
                    }
                ),
                { numRuns }
            );
        });
    });
});
