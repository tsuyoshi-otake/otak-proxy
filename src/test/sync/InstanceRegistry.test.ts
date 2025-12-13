/**
 * Unit tests for InstanceRegistry
 * Feature: multi-instance-sync
 * Requirements: 1.1, 1.2, 1.3, 1.4
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { InstanceRegistry, InstanceInfo, IInstanceRegistry } from '../../sync/InstanceRegistry';

suite('InstanceRegistry Unit Tests', () => {
    let testDir: string;
    let registry: IInstanceRegistry;

    setup(() => {
        // Create a temporary directory for tests
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-registry-test-'));
        registry = new InstanceRegistry(testDir, 'test-window-id');
    });

    teardown(async () => {
        // Unregister and clean up
        try {
            await registry.unregister();
        } catch {
            // Ignore unregister errors
        }

        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Requirement 1.1: Instance detection
     * Requirement 1.2: Instance notification
     */
    suite('Instance Registration (Requirements 1.1, 1.2)', () => {
        test('should register current instance', async () => {
            const result = await registry.register();

            assert.strictEqual(result, true, 'Registration should succeed');

            const instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 1, 'Should have one registered instance');
        });

        test('should include required fields in registration', async () => {
            await registry.register();

            const instances = await registry.getActiveInstances();
            const instance = instances[0];

            assert.ok(instance.id, 'Should have instance ID');
            assert.ok(instance.pid, 'Should have process ID');
            assert.ok(instance.windowId, 'Should have window ID');
            assert.ok(instance.registeredAt, 'Should have registration timestamp');
            assert.ok(instance.lastHeartbeat, 'Should have heartbeat timestamp');
        });

        test('should generate unique instance ID', async () => {
            await registry.register();
            const instances1 = await registry.getActiveInstances();

            // Create second registry instance
            const registry2 = new InstanceRegistry(testDir, 'test-window-id-2');
            await registry2.register();

            const instances2 = await registry.getActiveInstances();

            assert.strictEqual(instances2.length, 2, 'Should have two instances');
            assert.notStrictEqual(instances2[0].id, instances2[1].id, 'IDs should be unique');

            await registry2.unregister();
        });

        test('should use current process ID', async () => {
            await registry.register();

            const instances = await registry.getActiveInstances();
            assert.strictEqual(instances[0].pid, process.pid, 'Should use current process ID');
        });
    });

    /**
     * Requirement 1.3: Instance unregistration
     */
    suite('Instance Unregistration (Requirement 1.3)', () => {
        test('should unregister current instance', async () => {
            await registry.register();

            let instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 1);

            await registry.unregister();

            instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 0, 'Should have no instances after unregister');
        });

        test('should not fail when unregistering without registration', async () => {
            // Should not throw
            await registry.unregister();
            assert.ok(true);
        });

        test('should only unregister own instance', async () => {
            await registry.register();

            // Create and register second instance
            const registry2 = new InstanceRegistry(testDir, 'test-window-id-2');
            await registry2.register();

            let instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 2);

            // Unregister first instance
            await registry.unregister();

            instances = await registry2.getActiveInstances();
            assert.strictEqual(instances.length, 1, 'Should have one remaining instance');

            await registry2.unregister();
        });
    });

    /**
     * Requirement 1.4: Periodic existence verification
     */
    suite('Other Instance Detection (Requirement 1.4)', () => {
        test('should detect other instances', async () => {
            await registry.register();

            let hasOthers = await registry.hasOtherInstances();
            assert.strictEqual(hasOthers, false, 'Should not have other instances initially');

            // Create second instance
            const registry2 = new InstanceRegistry(testDir, 'test-window-id-2');
            await registry2.register();

            hasOthers = await registry.hasOtherInstances();
            assert.strictEqual(hasOthers, true, 'Should detect other instance');

            await registry2.unregister();
        });

        test('should return empty array when no instances registered', async () => {
            const instances = await registry.getActiveInstances();
            assert.deepStrictEqual(instances, []);
        });
    });

    /**
     * Heartbeat and cleanup
     */
    suite('Heartbeat and Cleanup', () => {
        test('should update heartbeat timestamp', async () => {
            await registry.register();

            const instancesBefore = await registry.getActiveInstances();
            const heartbeatBefore = instancesBefore[0].lastHeartbeat;

            // Wait a bit
            await new Promise(resolve => setTimeout(resolve, 100));

            // Update heartbeat
            await registry.updateHeartbeat();

            const instancesAfter = await registry.getActiveInstances();
            const heartbeatAfter = instancesAfter[0].lastHeartbeat;

            assert.ok(heartbeatAfter >= heartbeatBefore, 'Heartbeat should be updated');
        });

        test('should cleanup zombie instances', async () => {
            // Register current instance
            await registry.register();

            // Manually add a zombie instance with old heartbeat
            const lockPath = path.join(testDir, 'otak-proxy-sync', 'instances.lock');
            const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));

            // Add zombie with very old heartbeat
            content.instances.push({
                id: 'zombie-instance',
                pid: 99999, // Non-existent PID
                windowId: 'zombie-window',
                registeredAt: Date.now() - 120000, // 2 minutes ago
                lastHeartbeat: Date.now() - 60000, // 1 minute ago (stale)
                extensionVersion: '2.1.3'
            });

            fs.writeFileSync(lockPath, JSON.stringify(content, null, 2), 'utf-8');

            // Verify zombie was added
            let instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 2);

            // Cleanup
            const cleaned = await registry.cleanup();

            // Should have cleaned up the zombie
            assert.ok(cleaned >= 1, 'Should have cleaned at least one zombie');

            instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 1, 'Should have only current instance');
        });
    });

    /**
     * File handling
     */
    suite('File Handling', () => {
        test('should create lock file on first registration', async () => {
            const lockPath = path.join(testDir, 'otak-proxy-sync', 'instances.lock');

            assert.strictEqual(fs.existsSync(lockPath), false, 'Lock file should not exist initially');

            await registry.register();

            assert.strictEqual(fs.existsSync(lockPath), true, 'Lock file should exist after registration');
        });

        test('should handle corrupted lock file', async () => {
            // Create corrupted lock file
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });

            const lockPath = path.join(syncDir, 'instances.lock');
            fs.writeFileSync(lockPath, '{invalid json}}}', 'utf-8');

            // Registration should recover and succeed
            const result = await registry.register();
            assert.strictEqual(result, true, 'Should recover from corrupted file');
        });

        test('should include extension version in registration', async () => {
            await registry.register();

            const instances = await registry.getActiveInstances();
            assert.ok(instances[0].extensionVersion, 'Should have extension version');
        });
    });

    /**
     * Concurrent access
     */
    suite('Concurrent Access', () => {
        test('should handle concurrent registrations', async () => {
            const registries: IInstanceRegistry[] = [];

            // Create multiple registries
            for (let i = 0; i < 3; i++) {
                registries.push(new InstanceRegistry(testDir, `window-${i}`));
            }

            // Register all concurrently
            await Promise.all(registries.map(r => r.register()));

            // All should be registered
            const instances = await registry.getActiveInstances();
            assert.strictEqual(instances.length, 3, 'All instances should be registered');

            // Cleanup
            await Promise.all(registries.map(r => r.unregister()));
        });
    });
});
