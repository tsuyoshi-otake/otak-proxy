/**
 * Integration tests for Multi-Instance Sync
 * Feature: multi-instance-sync
 * Requirements: All requirements tested end-to-end
 *
 * Tests simulate multiple instances syncing through shared state file
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SyncManager, ISyncManager, SyncStatus } from '../../sync/SyncManager';
import { SharedStateFile, SharedState } from '../../sync/SharedStateFile';
import { InstanceRegistry } from '../../sync/InstanceRegistry';
import { ConflictResolver, SyncableState } from '../../sync/ConflictResolver';
import { ProxyMode, ProxyState } from '../../core/types';

suite('Multi-Instance Sync Integration Tests', () => {
    let testDir: string;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-integration-'));
    });

    teardown(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Create a mock config manager for testing
     */
    function createMockConfig(enabled: boolean = true) {
        return {
            isSyncEnabled: () => enabled,
            getSyncInterval: () => 1000,
            onConfigChange: () => ({ dispose: () => {} }),
            dispose: () => {}
        };
    }

    /**
     * Test: Two instances syncing state changes
     */
    suite('Two Instance Sync Flow', () => {
        test('should propagate state change from instance 1 to instance 2', async () => {
            // Create two sync managers (simulating two VSCode instances)
            const manager1 = new SyncManager(testDir, 'window-1', createMockConfig() as any);
            const manager2 = new SyncManager(testDir, 'window-2', createMockConfig() as any);

            try {
                // Start both instances
                await manager1.start();
                await manager2.start();

                // Instance 1 changes state
                const newState: ProxyState = {
                    mode: ProxyMode.Manual,
                    manualProxyUrl: 'http://proxy1.example.com:8080'
                };

                await manager1.notifyChange(newState);

                // Wait for file to be written
                await new Promise(resolve => setTimeout(resolve, 200));

                // Verify shared state file contains the change
                const sharedStateFile = new SharedStateFile(testDir);
                const sharedState = await sharedStateFile.read();

                assert.ok(sharedState, 'Shared state should exist');
                assert.strictEqual(sharedState!.proxyState.mode, ProxyMode.Manual);
                assert.strictEqual(sharedState!.proxyState.manualProxyUrl, 'http://proxy1.example.com:8080');

            } finally {
                await manager1.stop();
                await manager2.stop();
            }
        });

        test('should detect multiple active instances', async () => {
            const manager1 = new SyncManager(testDir, 'window-1', createMockConfig() as any);
            const manager2 = new SyncManager(testDir, 'window-2', createMockConfig() as any);

            try {
                await manager1.start();
                await manager2.start();

                // Give some time for registration
                await new Promise(resolve => setTimeout(resolve, 100));

                // Check instance registry
                const registry = new InstanceRegistry(testDir, 'check-window');
                const instances = await registry.getActiveInstances();

                assert.ok(instances.length >= 2, 'Should have at least 2 instances registered');

            } finally {
                await manager1.stop();
                await manager2.stop();
            }
        });
    });

    /**
     * Test: Conflict resolution scenarios
     */
    suite('Conflict Resolution Scenarios', () => {
        test('should resolve simultaneous changes using timestamp', async () => {
            const resolver = new ConflictResolver();

            // Simulate two instances making changes at different times
            const localState: SyncableState = {
                state: { mode: ProxyMode.Manual, manualProxyUrl: 'http://local:8080' },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remoteState: SyncableState = {
                state: { mode: ProxyMode.Auto, autoProxyUrl: 'http://remote:8080' },
                timestamp: 2000, // Newer
                instanceId: 'instance-2',
                version: 1
            };

            const resolution = resolver.resolve(localState, remoteState);

            assert.strictEqual(resolution.winner, 'remote', 'Newer timestamp should win');
            assert.strictEqual(resolution.resolvedState.state.mode, ProxyMode.Auto);
        });

        test('should handle rapid state changes from multiple instances', async () => {
            const sharedStateFile = new SharedStateFile(testDir);

            // Simulate rapid writes from different instances
            const writes: Promise<void>[] = [];

            for (let i = 0; i < 5; i++) {
                const state: SharedState = {
                    version: i + 1,
                    lastModified: Date.now() + i,
                    lastModifiedBy: `instance-${i}`,
                    proxyState: {
                        mode: i % 2 === 0 ? ProxyMode.Manual : ProxyMode.Auto,
                        manualProxyUrl: `http://proxy${i}:8080`
                    }
                };
                writes.push(sharedStateFile.write(state));
            }

            await Promise.all(writes);

            // Final state should be valid
            const finalState = await sharedStateFile.read();
            assert.ok(finalState, 'Should have valid state after rapid writes');
            assert.ok(finalState!.version >= 1, 'Should have valid version');
        });
    });

    /**
     * Test: File corruption recovery
     */
    suite('File Corruption Recovery', () => {
        test('should recover from corrupted state file', async () => {
            const sharedStateFile = new SharedStateFile(testDir);

            // Write valid state
            await sharedStateFile.write({
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test',
                proxyState: { mode: ProxyMode.Off }
            });

            // Corrupt the file
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            const filePath = path.join(syncDir, 'sync-state.json');
            fs.writeFileSync(filePath, '{corrupted data}}}', 'utf-8');

            // Read should return null for corrupted file
            const readState = await sharedStateFile.read();
            assert.strictEqual(readState, null, 'Should return null for corrupted file');

            // Recovery should fix the issue
            const recovered = await sharedStateFile.recover();
            assert.strictEqual(recovered, true, 'Recovery should succeed');

            // Should be able to write new state
            await sharedStateFile.write({
                version: 2,
                lastModified: Date.now(),
                lastModifiedBy: 'recovered',
                proxyState: { mode: ProxyMode.Manual }
            });

            const newState = await sharedStateFile.read();
            assert.ok(newState, 'Should be able to read after recovery');
            assert.strictEqual(newState!.version, 2);
        });

        test('should handle missing sync directory', async () => {
            const sharedStateFile = new SharedStateFile(testDir);

            // Directory doesn't exist yet
            const state = await sharedStateFile.read();
            assert.strictEqual(state, null, 'Should return null when directory missing');

            // Write should create directory
            await sharedStateFile.write({
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test',
                proxyState: { mode: ProxyMode.Off }
            });

            const exists = await sharedStateFile.exists();
            assert.strictEqual(exists, true, 'File should exist after write');
        });
    });

    /**
     * Test: Sync enable/disable toggle
     */
    suite('Sync Enable/Disable Toggle', () => {
        test('should work in standalone mode when sync disabled', async () => {
            const manager = new SyncManager(testDir, 'window-1', createMockConfig(false) as any);

            try {
                const started = await manager.start();
                assert.strictEqual(started, true, 'Should start in standalone mode');

                // Should be able to notify changes (they just won't sync)
                await manager.notifyChange({ mode: ProxyMode.Manual });

                const status = manager.getSyncStatus();
                assert.ok(status, 'Should return status');

            } finally {
                await manager.stop();
            }
        });

        test('should transition between enabled and disabled states', async () => {
            let syncEnabled = true;
            const mockConfig = {
                isSyncEnabled: () => syncEnabled,
                getSyncInterval: () => 1000,
                onConfigChange: () => ({ dispose: () => {} }),
                dispose: () => {}
            };

            const manager = new SyncManager(testDir, 'window-1', mockConfig as any);

            try {
                await manager.start();
                let status = manager.getSyncStatus();
                assert.strictEqual(status.enabled, true);

                await manager.stop();
                status = manager.getSyncStatus();
                assert.strictEqual(status.enabled, false);

            } finally {
                await manager.stop();
            }
        });
    });

    /**
     * Test: Error handling and fallback
     */
    suite('Error Handling and Fallback', () => {
        test('should continue operating after sync error', async () => {
            const manager = new SyncManager(testDir, 'window-1', createMockConfig() as any);

            try {
                await manager.start();

                // Force an error by corrupting state file
                const syncDir = path.join(testDir, 'otak-proxy-sync');
                fs.mkdirSync(syncDir, { recursive: true });
                fs.writeFileSync(path.join(syncDir, 'sync-state.json'), '{bad}', 'utf-8');

                // Trigger sync - should not throw
                const result = await manager.triggerSync();
                assert.ok(result !== undefined, 'Should return result even on error');

                // Should still be able to notify changes
                await manager.notifyChange({ mode: ProxyMode.Off });

                // Status should still work
                const status = manager.getSyncStatus();
                assert.ok(status !== undefined);

            } finally {
                await manager.stop();
            }
        });

        test('should handle instance registry failures gracefully', async () => {
            const registry = new InstanceRegistry(testDir, 'test-window');

            // Register
            await registry.register();

            // Corrupt the lock file
            const lockPath = path.join(testDir, 'otak-proxy-sync', 'instances.lock');
            fs.writeFileSync(lockPath, '{corrupted}', 'utf-8');

            // Operations should still work (with recovery)
            const instances = await registry.getActiveInstances();
            // May return empty array due to corruption
            assert.ok(Array.isArray(instances));

            await registry.unregister();
        });
    });

    /**
     * Test: Test result sharing
     */
    suite('Test Result Sharing', () => {
        test('should share test results between instances', async () => {
            const sharedStateFile = new SharedStateFile(testDir);

            // Write state with test result
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: {
                    mode: ProxyMode.Auto,
                    autoProxyUrl: 'http://proxy:8080'
                },
                testResult: {
                    success: true,
                    testUrls: ['https://example.com', 'https://google.com'],
                    errors: [],
                    proxyUrl: 'http://proxy:8080',
                    timestamp: Date.now(),
                    duration: 150
                }
            };

            await sharedStateFile.write(state);

            // Read from another "instance"
            const readState = await sharedStateFile.read();

            assert.ok(readState!.testResult);
            assert.strictEqual(readState!.testResult!.success, true);
            assert.strictEqual(readState!.testResult!.testUrls.length, 2);
            assert.strictEqual(readState!.testResult!.duration, 150);
        });
    });

    /**
     * Test: Instance cleanup
     */
    suite('Instance Cleanup', () => {
        test('should cleanup zombie instances', async () => {
            const registry = new InstanceRegistry(testDir, 'active-window');
            await registry.register();

            // Manually add a stale instance entry
            const lockPath = path.join(testDir, 'otak-proxy-sync', 'instances.lock');
            const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));

            content.instances.push({
                id: 'zombie-id',
                pid: 99999, // Non-existent PID
                windowId: 'zombie-window',
                registeredAt: Date.now() - 120000,
                lastHeartbeat: Date.now() - 60000, // Stale
                extensionVersion: '2.1.3'
            });

            fs.writeFileSync(lockPath, JSON.stringify(content), 'utf-8');

            // Cleanup should remove zombie
            const cleaned = await registry.cleanup();
            assert.ok(cleaned >= 1, 'Should have cleaned up zombie');

            // Active instance should remain
            const instances = await registry.getActiveInstances();
            assert.ok(instances.some(i => i.windowId === 'active-window'));

            await registry.unregister();
        });
    });
});
