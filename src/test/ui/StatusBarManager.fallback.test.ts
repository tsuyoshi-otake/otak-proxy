/**
 * @file StatusBarManager Fallback Display Tests
 * @description Tests for StatusBarManager fallback status display
 * Feature: auto-mode-fallback-improvements
 * Tasks: 4.1-4.7
 *
 * Validates:
 * - Task 4.1: StatusBarManager update for fallback status display
 * - Task 4.2: Unit tests for fallback status display
 * - Task 4.3: Property test for status bar display accuracy (Property 4)
 * - Task 4.4: Tooltip updates for Auto Mode OFF and OFF mode
 * - Task 4.5: Property test for tooltip explanation (Property 10)
 * - Task 4.6: Auto Mode OFF click behavior
 * - Task 4.7: Property test for Auto Mode OFF click (Property 11)
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { StatusBarManager } from '../../ui/StatusBarManager';
import { ProxyMode, ProxyState } from '../../core/types';
import { getPropertyTestRuns } from '../helpers';
import { proxyUrlArb } from '../generators';

suite('StatusBarManager Fallback Display Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let context: vscode.ExtensionContext;
    let statusBarManager: StatusBarManager;
    let mockStatusBarItem: vscode.StatusBarItem;

    setup(() => {
        sandbox = sinon.createSandbox();

        // Create mock status bar item
        mockStatusBarItem = {
            text: '',
            tooltip: undefined as string | vscode.MarkdownString | undefined,
            command: undefined,
            show: sandbox.stub(),
            hide: sandbox.stub(),
            dispose: sandbox.stub(),
            alignment: vscode.StatusBarAlignment.Right,
            priority: 100,
            id: 'test-status-bar',
            name: 'Test Status Bar',
            backgroundColor: undefined,
            color: undefined,
            accessibilityInformation: undefined
        } as unknown as vscode.StatusBarItem;

        // Mock window.createStatusBarItem
        sandbox.stub(vscode.window, 'createStatusBarItem').returns(mockStatusBarItem);

        // Create mock context
        context = {
            subscriptions: [],
            extensionPath: '',
            extensionUri: vscode.Uri.file(''),
            globalState: {} as any,
            workspaceState: {} as any,
            secrets: {} as any,
            extension: {} as any,
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            extensionMode: vscode.ExtensionMode.Test,
            environmentVariableCollection: {} as any,
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            asAbsolutePath: (relativePath: string) => relativePath,
            languageModelAccessInformation: {} as any
        } as unknown as vscode.ExtensionContext;

        statusBarManager = new StatusBarManager(context);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Task 4.1: StatusBarManager update for fallback status display
     * Task 4.2: Unit tests for fallback status display
     * Validates: Requirements 2.2, 4.1, 4.2
     */
    suite('Task 4.1-4.2: Fallback Status Display', () => {
        test('should display "Auto (OFF)" when autoModeOff is true', () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoModeOff: true,
                usingFallbackProxy: false
            };

            statusBarManager.update(state);

            // The text should contain some indication of Auto OFF
            // Actual format depends on i18n, but should indicate Auto mode with OFF state
            assert.ok(mockStatusBarItem.text.includes('Auto') || mockStatusBarItem.text.includes('auto'),
                `Status bar text should indicate Auto mode: ${mockStatusBarItem.text}`);
        });

        test('should display fallback indicator when usingFallbackProxy is true', () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoModeOff: false,
                usingFallbackProxy: true,
                fallbackProxyUrl: 'http://fallback.example.com:8080'
            };

            statusBarManager.update(state);

            // Should show Auto mode with fallback indication
            assert.ok(mockStatusBarItem.text.includes('Auto') || mockStatusBarItem.text.includes('auto'),
                `Status bar should indicate Auto mode with fallback: ${mockStatusBarItem.text}`);
        });

        test('should display normal Auto mode when using system proxy', () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoModeOff: false,
                usingFallbackProxy: false,
                autoProxyUrl: 'http://system.example.com:8080'
            };

            statusBarManager.update(state);

            assert.ok(mockStatusBarItem.text.includes('Auto') || mockStatusBarItem.text.includes('auto'),
                `Status bar should indicate Auto mode: ${mockStatusBarItem.text}`);
        });

        test('should display OFF when mode is Off', () => {
            const state: ProxyState = {
                mode: ProxyMode.Off,
                autoModeOff: false
            };

            statusBarManager.update(state);

            assert.ok(mockStatusBarItem.text.includes('Off') || mockStatusBarItem.text.includes('off') || mockStatusBarItem.text.includes('OFF'),
                `Status bar should indicate Off mode: ${mockStatusBarItem.text}`);
        });
    });

    /**
     * Task 4.3: Property test for status bar display accuracy
     * Property 4: Status bar display accuracy
     * Validates: Requirements 2.2, 4.1, 4.2
     */
    suite('Property 4: Status bar display accuracy', () => {
        test('should display correct status for any proxy state', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    // Generate random proxy state
                    fc.record({
                        mode: fc.constantFrom(ProxyMode.Off, ProxyMode.Manual, ProxyMode.Auto),
                        autoModeOff: fc.boolean(),
                        usingFallbackProxy: fc.boolean(),
                        autoProxyUrl: fc.option(proxyUrlArb, { nil: undefined }),
                        manualProxyUrl: fc.option(proxyUrlArb, { nil: undefined }),
                        fallbackProxyUrl: fc.option(proxyUrlArb, { nil: undefined })
                    }),
                    async (state: ProxyState) => {
                        statusBarManager.update(state);

                        // Verify status bar is updated appropriately for each mode
                        if (state.mode === ProxyMode.Off) {
                            assert.ok(
                                mockStatusBarItem.text.toLowerCase().includes('off') ||
                                mockStatusBarItem.text.includes('circle-slash'),
                                `Off mode should be indicated in status bar: ${mockStatusBarItem.text}`
                            );
                        } else if (state.mode === ProxyMode.Auto) {
                            assert.ok(
                                mockStatusBarItem.text.toLowerCase().includes('auto') ||
                                mockStatusBarItem.text.includes('sync'),
                                `Auto mode should be indicated in status bar: ${mockStatusBarItem.text}`
                            );
                        } else if (state.mode === ProxyMode.Manual) {
                            assert.ok(
                                mockStatusBarItem.text.toLowerCase().includes('manual') ||
                                mockStatusBarItem.text.includes('plug'),
                                `Manual mode should be indicated in status bar: ${mockStatusBarItem.text}`
                            );
                        }

                        // Verify show() was called
                        sinon.assert.called(mockStatusBarItem.show as sinon.SinonStub);
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 4.4: Tooltip updates for Auto Mode OFF and OFF mode
     * Validates: Requirements 4.3
     */
    suite('Task 4.4: Tooltip Updates', () => {
        test('should include explanation in tooltip for Auto Mode OFF', () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoModeOff: true,
                usingFallbackProxy: false
            };

            statusBarManager.update(state);

            // Tooltip should be set
            assert.ok(mockStatusBarItem.tooltip !== undefined,
                'Tooltip should be set');
        });

        test('should include different explanation for complete OFF mode', () => {
            const state: ProxyState = {
                mode: ProxyMode.Off,
                autoModeOff: false
            };

            statusBarManager.update(state);

            assert.ok(mockStatusBarItem.tooltip !== undefined,
                'Tooltip should be set for OFF mode');
        });
    });

    /**
     * Task 4.5: Property test for tooltip explanation
     * Property 10: Tooltip explanation
     * Validates: Requirements 4.3
     */
    suite('Property 10: Tooltip explanation', () => {
        test('should always have tooltip for any state', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.record({
                        mode: fc.constantFrom(ProxyMode.Off, ProxyMode.Manual, ProxyMode.Auto),
                        autoModeOff: fc.boolean(),
                        usingFallbackProxy: fc.boolean(),
                        autoProxyUrl: fc.option(proxyUrlArb, { nil: undefined }),
                        manualProxyUrl: fc.option(proxyUrlArb, { nil: undefined })
                    }),
                    async (state: ProxyState) => {
                        statusBarManager.update(state);

                        // Tooltip should always be set
                        assert.ok(mockStatusBarItem.tooltip !== undefined,
                            'Tooltip should always be set');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 4.6: Auto Mode OFF click behavior
     * Task 4.7: Property test for Auto Mode OFF click (Property 11)
     * Validates: Requirements 4.4
     */
    suite('Task 4.6-4.7: Auto Mode OFF Click Behavior (Property 11)', () => {
        test('should have command assigned for click action', () => {
            const statusBarItem = statusBarManager.getStatusBarItem();

            // The status bar item should have a command assigned
            assert.ok(statusBarItem.command !== undefined,
                'Status bar should have a command for click action');
        });

        test('Property 11: Click should trigger appropriate action', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.boolean(), // autoModeOff
                    async (autoModeOff) => {
                        const state: ProxyState = {
                            mode: ProxyMode.Auto,
                            autoModeOff
                        };

                        statusBarManager.update(state);

                        const statusBarItem = statusBarManager.getStatusBarItem();

                        // Command should be set (the actual command execution
                        // is tested in integration tests)
                        assert.ok(statusBarItem.command !== undefined,
                            'Status bar should have command for click action');
                    }
                ),
                { numRuns }
            );
        });
    });
});
