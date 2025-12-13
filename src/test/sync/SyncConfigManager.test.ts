/**
 * Unit tests for SyncConfigManager
 * Feature: multi-instance-sync
 * Requirements: 8.1, 8.2, 8.3, 8.4
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { SyncConfigManager } from '../../sync/SyncConfigManager';

suite('SyncConfigManager Unit Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: SyncConfigManager;
    let mockConfig: { [key: string]: any };

    setup(() => {
        sandbox = sinon.createSandbox();
        mockConfig = {
            'syncEnabled': true,
            'syncInterval': 1000
        };

        // Mock vscode.workspace.getConfiguration
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in mockConfig) {
                    return mockConfig[key] as T;
                }
                return defaultValue;
            },
            has: (key: string) => key in mockConfig,
            inspect: () => undefined,
            update: async () => {}
        } as any);

        configManager = new SyncConfigManager();
    });

    teardown(() => {
        sandbox.restore();
        configManager.dispose();
    });

    /**
     * Requirement 8.1: Enable/disable sync setting
     */
    suite('Sync Enabled Setting (Requirement 8.1)', () => {
        test('should return true when sync is enabled', () => {
            mockConfig['syncEnabled'] = true;
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.isSyncEnabled(), true);
        });

        test('should return false when sync is disabled', () => {
            mockConfig['syncEnabled'] = false;
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.isSyncEnabled(), false);
        });

        test('should return true by default when setting is not configured', () => {
            delete mockConfig['syncEnabled'];
            configManager = new SyncConfigManager();

            // Default should be true as per design
            assert.strictEqual(configManager.isSyncEnabled(), true);
        });
    });

    /**
     * Requirement 8.3: Sync interval setting
     */
    suite('Sync Interval Setting (Requirement 8.3)', () => {
        test('should return configured interval in milliseconds', () => {
            mockConfig['syncInterval'] = 2000;
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.getSyncInterval(), 2000);
        });

        test('should return default interval (1000ms) when not configured', () => {
            delete mockConfig['syncInterval'];
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.getSyncInterval(), 1000);
        });

        test('should clamp interval to minimum (100ms)', () => {
            mockConfig['syncInterval'] = 50; // Below minimum
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.getSyncInterval(), 100);
        });

        test('should clamp interval to maximum (5000ms)', () => {
            mockConfig['syncInterval'] = 10000; // Above maximum
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.getSyncInterval(), 5000);
        });

        test('should accept interval within valid range', () => {
            mockConfig['syncInterval'] = 2500;
            configManager = new SyncConfigManager();

            assert.strictEqual(configManager.getSyncInterval(), 2500);
        });
    });

    /**
     * Requirement 8.2: Standalone mode when disabled
     * Requirement 8.4: Real-time setting changes
     */
    suite('Configuration Change Events (Requirement 8.4)', () => {
        test('should notify listener when syncEnabled changes', (done) => {
            let callCount = 0;
            const disposable = configManager.onConfigChange((key, value) => {
                callCount++;
                if (key === 'syncEnabled') {
                    assert.strictEqual(value, false);
                    disposable.dispose();
                    done();
                }
            });

            // Simulate configuration change
            configManager.handleConfigurationChange('syncEnabled', false);
        });

        test('should notify listener when syncInterval changes', (done) => {
            const disposable = configManager.onConfigChange((key, value) => {
                if (key === 'syncInterval') {
                    assert.strictEqual(value, 3000);
                    disposable.dispose();
                    done();
                }
            });

            configManager.handleConfigurationChange('syncInterval', 3000);
        });

        test('should support multiple listeners', () => {
            const received1: string[] = [];
            const received2: string[] = [];

            const disposable1 = configManager.onConfigChange((key) => {
                received1.push(key);
            });

            const disposable2 = configManager.onConfigChange((key) => {
                received2.push(key);
            });

            configManager.handleConfigurationChange('syncEnabled', true);

            assert.strictEqual(received1.length, 1);
            assert.strictEqual(received2.length, 1);
            assert.strictEqual(received1[0], 'syncEnabled');
            assert.strictEqual(received2[0], 'syncEnabled');

            disposable1.dispose();
            disposable2.dispose();
        });

        test('should not notify after listener is disposed', () => {
            const received: string[] = [];

            const disposable = configManager.onConfigChange((key) => {
                received.push(key);
            });

            configManager.handleConfigurationChange('syncEnabled', true);
            assert.strictEqual(received.length, 1);

            disposable.dispose();

            configManager.handleConfigurationChange('syncEnabled', false);
            assert.strictEqual(received.length, 1); // Should not change
        });
    });

    /**
     * VSCode Configuration Integration
     */
    suite('VSCode Configuration Integration', () => {
        test('should read from otakProxy configuration section', () => {
            const getConfigStub = vscode.workspace.getConfiguration as sinon.SinonStub;

            configManager.isSyncEnabled();

            assert.ok(getConfigStub.calledWith('otakProxy'));
        });

        test('should handle VSCode workspace.onDidChangeConfiguration', () => {
            // Test that configuration manager can be notified of changes
            const listener = configManager.createVSCodeConfigChangeListener();

            assert.ok(listener);
            assert.ok(typeof listener === 'function');
        });
    });

    /**
     * Edge cases
     */
    suite('Edge Cases', () => {
        test('should handle undefined values gracefully', () => {
            mockConfig['syncEnabled'] = undefined;
            mockConfig['syncInterval'] = undefined;
            configManager = new SyncConfigManager();

            // Should return defaults
            assert.strictEqual(configManager.isSyncEnabled(), true);
            assert.strictEqual(configManager.getSyncInterval(), 1000);
        });

        test('should handle invalid types gracefully', () => {
            mockConfig['syncEnabled'] = 'not-a-boolean';
            mockConfig['syncInterval'] = 'not-a-number';
            configManager = new SyncConfigManager();

            // Should return defaults for invalid types
            assert.strictEqual(configManager.isSyncEnabled(), true);
            assert.strictEqual(configManager.getSyncInterval(), 1000);
        });

        test('should handle negative interval values', () => {
            mockConfig['syncInterval'] = -100;
            configManager = new SyncConfigManager();

            // Should clamp to minimum
            assert.strictEqual(configManager.getSyncInterval(), 100);
        });
    });
});
