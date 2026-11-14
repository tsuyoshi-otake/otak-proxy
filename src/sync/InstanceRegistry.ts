/**
 * @file InstanceRegistry
 * @description Manages registration of active otak-proxy instances
 *
 * Feature: multi-instance-sync
 * Requirements: 1.1, 1.2, 1.3, 1.4
 *
 * Provides:
 * - Instance detection (1.1)
 * - New instance notification via registration (1.2)
 * - Instance unregistration on exit (1.3)
 * - Periodic existence verification via heartbeat (1.4)
 */

import { Logger } from '../utils/Logger';
import { HEARTBEAT_TIMEOUT } from './InstanceRegistryConstants';
import { generateInstanceId } from './InstanceId';
import { InstanceRegistryStore } from './InstanceRegistryStore';
import { IInstanceRegistry, InstanceInfo } from './InstanceRegistryTypes';

export type { IInstanceRegistry, InstanceInfo } from './InstanceRegistryTypes';

/**
 * InstanceRegistry manages the registration of active otak-proxy instances.
 *
 * Each instance registers itself on startup and unregisters on shutdown.
 * Zombie instances (crashed without cleanup) are detected via heartbeat timeout.
 */
export class InstanceRegistry implements IInstanceRegistry {
    private readonly store: InstanceRegistryStore;
    private instanceId: string | null = null;
    private registeredAt: number | null = null;
    private readonly windowId: string;
    private readonly pid: number;
    private readonly extensionVersion: string;

    /**
     * Create a new InstanceRegistry
     *
     * @param baseDir Base directory (typically globalStorageUri.fsPath)
     * @param windowId VSCode window identifier
     * @param extensionVersion Extension version string (for diagnostics)
     */
    constructor(baseDir: string, windowId: string, extensionVersion: string = 'unknown') {
        this.windowId = windowId;
        this.pid = process.pid;
        this.extensionVersion = extensionVersion;
        this.store = new InstanceRegistryStore(baseDir, this.pid);
    }

    /**
     * Register the current instance
     *
     * @returns True if registration succeeded
     */
    async register(): Promise<boolean> {
        try {
            // Generate instance ID
            this.instanceId = generateInstanceId();

            const now = Date.now();
            this.registeredAt = now;
            const instanceInfo: InstanceInfo = {
                id: this.instanceId,
                pid: this.pid,
                windowId: this.windowId,
                registeredAt: now,
                lastHeartbeat: now,
                extensionVersion: this.extensionVersion
            };

            const written = await this.store.withLock(async () => {
                // Read existing lock file
                const lockFile = await this.store.readLockFileWithRetry();
                if (!lockFile) {
                    return false;
                }

                // Add this instance
                lockFile.instances.push(instanceInfo);

                // Write updated lock file
                await this.store.writeLockFile(lockFile);
                return true;
            });

            if (written) {
                Logger.log(`Registered instance: ${this.instanceId}`);
            }
            // A persistently unreadable registry is not fatal: this window's
            // id is already assigned and the heartbeat re-adds its entry on
            // the next tick, so registration converges instead of disabling
            // sync for the session (#137).
            return true;
        } catch (error) {
            Logger.error('Failed to register instance:', error);
            this.instanceId = null;
            this.registeredAt = null;
            return false;
        }
    }

    /**
     * Unregister the current instance
     */
    async unregister(): Promise<void> {
        if (!this.instanceId) {
            return;
        }

        try {
            await this.store.withLock(async () => {
                const lockFile = await this.store.readLockFileWithRetry();
                if (!lockFile) {
                    return;
                }

                // Remove this instance
                lockFile.instances = lockFile.instances.filter(
                    instance => instance.id !== this.instanceId
                );

                // Write updated lock file
                await this.store.writeLockFile(lockFile);
            });

            Logger.log(`Unregistered instance: ${this.instanceId}`);
            this.instanceId = null;
            this.registeredAt = null;
        } catch (error) {
            Logger.error('Failed to unregister instance:', error);
        }
    }

    /**
     * Get list of active instances
     */
    async getActiveInstances(): Promise<InstanceInfo[]> {
        try {
            const lockFile = await this.store.readLockFile();
            return lockFile.instances;
        } catch (error) {
            Logger.error('Failed to get active instances:', error);
            return [];
        }
    }

    /**
     * Check if other instances exist
     */
    async hasOtherInstances(): Promise<boolean> {
        const instances = await this.getActiveInstances();
        return instances.some(instance => instance.id !== this.instanceId);
    }

    /**
     * Cleanup inactive instances (zombies)
     *
     * @returns Number of instances cleaned up
     */
    async cleanup(): Promise<number> {
        try {
            return await this.store.withLock(async () => {
                const lockFile = await this.store.readLockFileWithRetry();
                if (!lockFile) {
                    return 0;
                }
                const now = Date.now();
                let cleanedCount = 0;

                // Filter out zombie instances
                lockFile.instances = lockFile.instances.filter(instance => {
                    // Check heartbeat timeout
                    const isStale = (now - instance.lastHeartbeat) > HEARTBEAT_TIMEOUT;

                    // Check if process exists (only for non-current instances)
                    const isZombie = isStale || (
                        instance.id !== this.instanceId &&
                        !this.isProcessAlive(instance.pid)
                    );

                    if (isZombie) {
                        Logger.log(`Cleaning up zombie instance: ${instance.id} (pid: ${instance.pid})`);
                        cleanedCount++;
                        return false;
                    }

                    return true;
                });

                if (cleanedCount > 0) {
                    await this.store.writeLockFile(lockFile);
                }

                return cleanedCount;
            });
        } catch (error) {
            Logger.error('Failed to cleanup instances:', error);
            return 0;
        }
    }

    /**
     * Update heartbeat for current instance
     */
    async updateHeartbeat(): Promise<void> {
        const instanceId = this.instanceId;
        if (!instanceId) {
            return;
        }

        try {
            await this.store.withLock(async () => {
                const lockFile = await this.store.readLockFileWithRetry();
                if (!lockFile) {
                    return;
                }
                const now = Date.now();

                // Find and update this instance's heartbeat
                let found = false;
                for (const instance of lockFile.instances) {
                    if (instance.id === instanceId) {
                        instance.lastHeartbeat = now;
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    // A cleanup or a wiped registry dropped this live window's
                    // entry; the heartbeat puts it back instead of leaving the
                    // window invisible to its peers (#137).
                    lockFile.instances.push({
                        id: instanceId,
                        pid: this.pid,
                        windowId: this.windowId,
                        registeredAt: this.registeredAt ?? now,
                        lastHeartbeat: now,
                        extensionVersion: this.extensionVersion
                    });
                }

                await this.store.writeLockFile(lockFile);
            });
        } catch (error) {
            Logger.error('Failed to update heartbeat:', error);
        }
    }

    /**
     * Get the current instance ID
     */
    getInstanceId(): string | null {
        return this.instanceId;
    }

    /**
     * Check if a process is alive
     */
    private isProcessAlive(pid: number): boolean {
        try {
            // Sending signal 0 checks if process exists without killing it
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}
