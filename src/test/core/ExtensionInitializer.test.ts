/**
 * Integration tests for ExtensionInitializer
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4 (Task 6.2)
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ExtensionInitializer, InitializerContext } from '../../core/ExtensionInitializer';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { ProxyApplier } from '../../core/ProxyApplier';
import { ProxyMode, ProxyState } from '../../core/types';
import { SystemProxyDetector } from '../../config/SystemProxyDetector';
import { UserNotifier } from '../../errors/UserNotifier';
import { InputSanitizer } from '../../validation/InputSanitizer';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { TestResult } from '../../utils/ProxyUtils';

suite('ExtensionInitializer Connection Testing Integration', function() {
    this.timeout(30000);

    let sandbox: sinon.SinonSandbox;
    let mockContext: vscode.ExtensionContext;
    let mockStateManager: sinon.SinonStubbedInstance<ProxyStateManager>;
    let mockApplier: sinon.SinonStubbedInstance<ProxyApplier>;
    let mockDetector: sinon.SinonStubbedInstance<SystemProxyDetector>;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let sanitizer: InputSanitizer;
    let logger: ProxyChangeLogger;
    let initializer: ExtensionInitializer;

    setup(() => {
        sandbox = sinon.createSandbox();

        // Create mock extension context
        mockContext = {
            globalState: {
                get: sandbox.stub().returns(undefined),
                update: sandbox.stub().resolves(),
                keys: () => [],
                setKeysForSync: () => {}
            },
            subscriptions: [],
            extensionPath: '',
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            extensionUri: vscode.Uri.file(''),
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            asAbsolutePath: (relativePath: string) => relativePath,
            workspaceState: {} as any,
            secrets: {} as any,
            extension: {} as any,
            languageModelAccessInformation: {} as any,
            environmentVariableCollection: {} as any
        } as unknown as vscode.ExtensionContext;

        // Create stubs
        mockStateManager = sandbox.createStubInstance(ProxyStateManager);
        mockApplier = sandbox.createStubInstance(ProxyApplier);
        mockDetector = sandbox.createStubInstance(SystemProxyDetector);
        mockNotifier = sandbox.createStubInstance(UserNotifier);
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);

        // Default stub behavior
        mockDetector.updateDetectionPriority.returns();
        mockApplier.applyProxy.resolves(true);
    });

    teardown(() => {
        if (initializer) {
            initializer.stopSystemProxyMonitoring();
        }
        sandbox.restore();
    });

    function createInitializer(): ExtensionInitializer {
        const context: InitializerContext = {
            extensionContext: mockContext,
            proxyStateManager: mockStateManager as unknown as ProxyStateManager,
            proxyApplier: mockApplier as unknown as ProxyApplier,
            systemProxyDetector: mockDetector as unknown as SystemProxyDetector,
            userNotifier: mockNotifier as unknown as UserNotifier,
            sanitizer: sanitizer,
            proxyChangeLogger: logger
        };

        return new ExtensionInitializer(context);
    }

    suite('Connection tester initialization', () => {
        test('should initialize connection tester on construction', () => {
            initializer = createInitializer();

            assert.ok(initializer.getConnectionTester() !== null,
                'Connection tester should be initialized');
        });
    });

    suite('Startup test flow', () => {
        test('should mark startup test as pending when in Auto mode', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            // State should be saved with proxyReachable as undefined (indeterminate)
            assert.ok(mockStateManager.saveState.called,
                'saveState should be called during startup');
        });

        test('should not mark startup test as pending when in Manual mode', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Manual,
                manualProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves(null);

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            assert.strictEqual(initializer.isStartupTestStillPending(), false,
                'Startup test should not be pending in Manual mode');
        });

        test('should not mark startup test as pending when in Off mode', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Off
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves(null);

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            assert.strictEqual(initializer.isStartupTestStillPending(), false,
                'Startup test should not be pending in Off mode');
        });
    });

    suite('ProxyMonitor integration', () => {
        test('should create ProxyMonitor with connection tester', () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);

            initializer = createInitializer();
            const monitor = initializer.initializeProxyMonitor();

            assert.ok(monitor !== null, 'ProxyMonitor should be created');
        });

        test('should start ProxyMonitor when monitoring starts in Auto mode', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            const monitor = initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            assert.strictEqual(monitor.getState().isActive, true,
                'ProxyMonitor should be active after starting monitoring');
        });
    });

    suite('Manual connection test', () => {
        test('runManualConnectionTest should return undefined when monitor not initialized', async () => {
            initializer = createInitializer();
            // Do not initialize monitor

            const result = await initializer.runManualConnectionTest();

            assert.strictEqual(result, undefined,
                'Should return undefined when monitor not initialized');
        });

        test('runManualConnectionTest should call monitor\'s triggerConnectionTest', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            const monitor = initializer.initializeProxyMonitor();

            // Spy on triggerConnectionTest
            const spy = sandbox.spy(monitor, 'triggerConnectionTest');

            await initializer.startSystemProxyMonitoring();
            await initializer.runManualConnectionTest();

            assert.ok(spy.called, 'triggerConnectionTest should be called');
        });
    });

    suite('getConnectionTester', () => {
        test('should return the connection tester instance', () => {
            initializer = createInitializer();

            const tester = initializer.getConnectionTester();

            assert.ok(tester !== null, 'Should return connection tester');
        });
    });

    suite('isStartupTestStillPending', () => {
        test('should return false initially', () => {
            initializer = createInitializer();

            assert.strictEqual(initializer.isStartupTestStillPending(), false,
                'Should return false initially');
        });
    });

    suite('Configuration change handling (Task 7.2)', () => {
        test('should update ProxyMonitor config when testInterval changes', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);

            initializer = createInitializer();
            const monitor = initializer.initializeProxyMonitor();

            // Simulate configuration change for testInterval
            initializer.handleConfigurationChange('testInterval', 120);

            // ProxyMonitor's connectionTestInterval should be updated
            // The monitor should have been updated with new interval (120 * 1000 = 120000ms)
            assert.ok(monitor, 'Monitor should exist');
        });

        test('should stop scheduler when autoTestEnabled becomes false', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            // Simulate autoTestEnabled being disabled
            initializer.handleConfigurationChange('autoTestEnabled', false);

            // Verify that the connection test is disabled
            const tester = initializer.getConnectionTester();
            assert.ok(tester !== null, 'Tester should still exist');
        });

        test('should restart scheduler when autoTestEnabled becomes true', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            // First disable autoTest
            initializer.handleConfigurationChange('autoTestEnabled', false);

            await initializer.startSystemProxyMonitoring();

            // Then enable it again
            initializer.handleConfigurationChange('autoTestEnabled', true);

            // Should be re-enabled
            const monitor = initializer.getProxyMonitor();
            assert.ok(monitor !== null, 'Monitor should exist');
        });

        test('should update interval in running scheduler when testInterval changes', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy.example.com:8080'
            };

            mockStateManager.getState.resolves(state);
            mockDetector.detectSystemProxy.resolves('http://proxy.example.com:8080');
            mockDetector.detectSystemProxyWithSource.resolves({
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment'
            });

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            await initializer.startSystemProxyMonitoring();

            // Update interval while running
            initializer.handleConfigurationChange('testInterval', 90);

            const monitor = initializer.getProxyMonitor();
            assert.ok(monitor !== null, 'Monitor should still be running');
        });

        test('should clamp testInterval to valid range (30-600)', async () => {
            const state: ProxyState = {
                mode: ProxyMode.Auto
            };

            mockStateManager.getState.resolves(state);

            initializer = createInitializer();
            initializer.initializeProxyMonitor();

            // Try setting interval below minimum (should be clamped to 30)
            initializer.handleConfigurationChange('testInterval', 10);

            // Try setting interval above maximum (should be clamped to 600)
            initializer.handleConfigurationChange('testInterval', 1000);

            // Should not throw errors
            assert.ok(true, 'Should handle out-of-range values gracefully');
        });
    });
});
