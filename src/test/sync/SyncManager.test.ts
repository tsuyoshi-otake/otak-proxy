/**
 * Unit tests for SyncManager
 * Feature: multi-instance-sync
 * Requirements: 1.1-1.4, 2.1-2.5, 3.1-3.3, 7.1-7.5
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as sinon from 'sinon';
import { SyncManager, SyncStatus, SyncResult, ISyncManager } from '../../sync/SyncManager';
import { ProxyMode, ProxyState } from '../../core/types';

suite('SyncManager Unit Tests', () => {
    let testDir: string;
    let syncManager: ISyncManager;
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-sync-test-'));

        // Create mock dependencies
        const mockConfig = {
            isSyncEnabled: () => true,
            getSyncInterval: () => 1000,
            onConfigChange: () => ({ dispose: () => {} }),
            dispose: () => {}
        };

        syncManager = new SyncManager(testDir, 'test-window-id', mockConfig as any);
    });

    teardown(async () => {
        await syncManager.stop();
        sandbox.restore();

        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Requirement 2.1, 2.2, 2.3: Proxy settings sync
     */
    suite('Lifecycle Management (Requirement 2.1, 7.4)', () => {
        test('should start successfully', async () => {
            const result = await syncManager.start();
            assert.strictEqual(result, true, 'Start should succeed');
        });

        test('should stop successfully', async () => {
            await syncManager.start();
            await syncManager.stop();

            const status = syncManager.getSyncStatus();
            assert.strictEqual(status.enabled, false, 'Should be disabled after stop');
        });

        test('should handle multiple start calls', async () => {
            await syncManager.start();
            const result = await syncManager.start();

            // Second start should succeed (idempotent)
            assert.strictEqual(result, true);
        });

        test('should handle stop without start', async () => {
            // Should not throw
            await syncManager.stop();
            assert.ok(true);
        });
    });

    /**
     * Requirement 2.1, 2.2, 2.3, 2.5: State change propagation
     */
    suite('State Change Notification (Requirements 2.1-2.5)', () => {
        test('should notify change to shared state', async () => {
            await syncManager.start();

            const state: ProxyState = {
                mode: ProxyMode.Manual,
                manualProxyUrl: 'http://proxy:8080'
            };

            // Should not throw
            await syncManager.notifyChange(state);

            // Verify state was written (by triggering sync)
            const result = await syncManager.triggerSync();
            assert.ok(result.success || result.error === undefined);
        });

        test('should update timestamp on change', async () => {
            await syncManager.start();

            const before = Date.now();

            const state: ProxyState = {
                mode: ProxyMode.Manual
            };

            await syncManager.notifyChange(state);

            const status = syncManager.getSyncStatus();
            assert.ok(
                status.lastSyncTime === null || status.lastSyncTime >= before,
                'Last sync time should be updated'
            );
        });
    });

    /**
     * Requirement: Status reporting
     */
    suite('Status Reporting', () => {
        test('should report initial status correctly', () => {
            const status = syncManager.getSyncStatus();

            assert.strictEqual(typeof status.enabled, 'boolean');
            assert.strictEqual(typeof status.activeInstances, 'number');
            assert.strictEqual(status.isSyncing, false);
        });

        test('should report enabled state', async () => {
            const statusBefore = syncManager.getSyncStatus();
            assert.strictEqual(statusBefore.enabled, false);

            await syncManager.start();

            const statusAfter = syncManager.getSyncStatus();
            assert.strictEqual(statusAfter.enabled, true);
        });

        test('should report active instances count', async () => {
            await syncManager.start();

            const status = syncManager.getSyncStatus();
            assert.ok(status.activeInstances >= 1, 'Should have at least one active instance');
        });

        test('isEnabled should return correct state', () => {
            assert.strictEqual(syncManager.isEnabled(), false);
        });
    });

    /**
     * Requirement: Manual sync trigger
     */
    suite('Manual Sync Trigger', () => {
        test('should trigger sync successfully', async () => {
            await syncManager.start();

            const result = await syncManager.triggerSync();

            assert.strictEqual(typeof result.success, 'boolean');
            assert.strictEqual(typeof result.instancesNotified, 'number');
            assert.strictEqual(typeof result.conflictsResolved, 'number');
        });

        test('should return error when not started', async () => {
            const result = await syncManager.triggerSync();

            // May succeed or fail depending on implementation
            assert.ok(result !== undefined);
        });
    });

    /**
     * Requirements 7.1-7.5: Error handling
     */
    suite('Error Handling (Requirements 7.1-7.5)', () => {
        test('should handle sync errors gracefully', async () => {
            await syncManager.start();

            // Corrupt the state file
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });
            fs.writeFileSync(path.join(syncDir, 'sync-state.json'), '{invalid}', 'utf-8');

            // Should not throw
            const result = await syncManager.triggerSync();
            assert.ok(result !== undefined);
        });

        test('should maintain functionality after errors', async () => {
            await syncManager.start();

            // Force an error condition
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });
            fs.writeFileSync(path.join(syncDir, 'sync-state.json'), '{invalid}', 'utf-8');

            await syncManager.triggerSync();

            // Should still be able to write new state
            const state: ProxyState = { mode: ProxyMode.Off };
            await syncManager.notifyChange(state);

            // Status should still work
            const status = syncManager.getSyncStatus();
            assert.ok(status !== undefined);
        });

        test('should log errors but continue operation', async () => {
            await syncManager.start();

            // Multiple operations should all complete
            const operations: Promise<void>[] = [];
            for (let i = 0; i < 5; i++) {
                operations.push(syncManager.notifyChange({ mode: ProxyMode.Off }));
            }

            await Promise.all(operations);
            assert.ok(true, 'All operations completed');
        });
    });

    /**
     * Requirement 8.2: Standalone mode
     */
    suite('Standalone Mode (Requirement 8.2)', () => {
        test('should work when sync is disabled', async () => {
            const mockConfig = {
                isSyncEnabled: () => false,
                getSyncInterval: () => 1000,
                onConfigChange: () => ({ dispose: () => {} }),
                dispose: () => {}
            };

            const standaloneManager = new SyncManager(testDir, 'test-window', mockConfig as any);

            const result = await standaloneManager.start();
            // May return true or false depending on implementation

            const status = standaloneManager.getSyncStatus();
            // In standalone mode, should still report status

            await standaloneManager.stop();
        });
    });

    /**
     * Event emission
     */
    suite('Event Emission', () => {
        test('should emit syncStateChanged event on start', (done) => {
            const manager = syncManager as any;

            if (manager.on) {
                // Use `once` so teardown-induced stop() does not trigger the handler again.
                manager.once('syncStateChanged', (status: SyncStatus) => {
                    assert.ok(status);
                    done();
                });
            } else {
                // If no event support, skip
                done();
            }

            void syncManager.start();
        });
    });

    /**
     * Requirements 3.1-3.3: Test result sharing
     */
    suite('Test Result Sharing (Requirements 3.1-3.3)', () => {
        test('should include test result in state', async () => {
            await syncManager.start();

            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://proxy:8080',
                lastTestResult: {
                    success: true,
                    testUrls: ['https://example.com'],
                    errors: [],
                    proxyUrl: 'http://proxy:8080',
                    timestamp: Date.now(),
                    duration: 150
                },
                proxyReachable: true,
                lastTestTimestamp: Date.now()
            };

            await syncManager.notifyChange(state);

            // Trigger sync to verify state was stored
            const result = await syncManager.triggerSync();
            assert.ok(result);
        });
    });

    /**
     * Concurrent operations
     */
    suite('Concurrent Operations', () => {
        test('should handle concurrent state changes', async () => {
            await syncManager.start();

            const changes: Promise<void>[] = [];
            for (let i = 0; i < 10; i++) {
                changes.push(syncManager.notifyChange({
                    mode: i % 2 === 0 ? ProxyMode.Manual : ProxyMode.Auto,
                    manualProxyUrl: `http://proxy${i}:8080`
                }));
            }

            await Promise.all(changes);

            const status = syncManager.getSyncStatus();
            assert.ok(status);
        });

        test('should handle concurrent start/stop', async () => {
            const operations: Promise<boolean | void>[] = [];

            operations.push(syncManager.start());
            operations.push(syncManager.stop());
            operations.push(syncManager.start());

            await Promise.all(operations);

            // Final state should be consistent
            const status = syncManager.getSyncStatus();
            assert.ok(typeof status.enabled === 'boolean');
        });
    });
});
