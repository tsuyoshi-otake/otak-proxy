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

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';

/**
 * Information about a registered instance
 */
export interface InstanceInfo {
    /** Unique instance identifier (UUID) */
    id: string;
    /** Process ID */
    pid: number;
    /** VSCode window ID */
    windowId: string;
    /** Registration timestamp (Unix ms) */
    registeredAt: number;
    /** Last heartbeat timestamp (Unix ms) */
    lastHeartbeat: number;
    /** Extension version */
    extensionVersion: string;
}

/**
 * Interface for InstanceRegistry as defined in design.md
 */
export interface IInstanceRegistry {
    /**
     * Register the current instance
     * @returns True if registration succeeded
     */
    register(): Promise<boolean>;

    /**
     * Unregister the current instance
     */
    unregister(): Promise<void>;

    /**
     * Get list of active instances
     */
    getActiveInstances(): Promise<InstanceInfo[]>;

    /**
     * Check if other instances exist
     */
    hasOtherInstances(): Promise<boolean>;

    /**
     * Cleanup inactive instances
     * @returns Number of instances cleaned up
     */
    cleanup(): Promise<number>;

    /**
     * Update heartbeat for current instance
     */
    updateHeartbeat(): Promise<void>;
}

/**
 * Lock file structure
 */
interface InstancesLockFile {
    schemaVersion: number;
    instances: InstanceInfo[];
}

/**
 * Current schema version
 */
const SCHEMA_VERSION = 1;

/**
 * Sync directory name
 */
const SYNC_DIR_NAME = 'otak-proxy-sync';

/**
 * Lock file name
 */
const LOCK_FILE_NAME = 'instances.lock';

/**
 * Heartbeat timeout in milliseconds (30 seconds)
 */
const HEARTBEAT_TIMEOUT = 30000;

/**
 * Mutex acquisition timeout for updating the lock file.
 *
 * This protects against concurrent writers across VS Code windows/processes.
 */
const MUTEX_TIMEOUT_MS = 5000;

/**
 * If a mutex file is older than this, assume it is stale and remove it.
 */
const MUTEX_STALE_MS = 30000;

/**
 * Delay between mutex acquisition attempts.
 */
const MUTEX_RETRY_DELAY_MS = 25;

/**
 * Extension version (from package.json)
 */
const EXTENSION_VERSION = '2.1.3';

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * InstanceRegistry manages the registration of active otak-proxy instances.
 *
 * Each instance registers itself on startup and unregisters on shutdown.
 * Zombie instances (crashed without cleanup) are detected via heartbeat timeout.
 */
export class InstanceRegistry implements IInstanceRegistry {
    private readonly syncDir: string;
    private readonly lockFilePath: string;
    private readonly mutexFilePath: string;
    private instanceId: string | null = null;
    private readonly windowId: string;
    private readonly pid: number;

    /**
     * Create a new InstanceRegistry
     *
     * @param baseDir Base directory (typically globalStorageUri.fsPath)
     * @param windowId VSCode window identifier
     */
    constructor(baseDir: string, windowId: string) {
        this.syncDir = path.join(baseDir, SYNC_DIR_NAME);
        this.lockFilePath = path.join(this.syncDir, LOCK_FILE_NAME);
        this.mutexFilePath = `${this.lockFilePath}.mutex`;
        this.windowId = windowId;
        this.pid = process.pid;
    }

    /**
     * Register the current instance
     *
     * @returns True if registration succeeded
     */
    async register(): Promise<boolean> {
        try {
            // Generate instance ID
            this.instanceId = generateUUID();

            const now = Date.now();
            const instanceInfo: InstanceInfo = {
                id: this.instanceId,
                pid: this.pid,
                windowId: this.windowId,
                registeredAt: now,
                lastHeartbeat: now,
                extensionVersion: EXTENSION_VERSION
            };

            await this.withLock(async () => {
                // Read existing lock file
                const lockFile = await this.readLockFile();

                // Add this instance
                lockFile.instances.push(instanceInfo);

                // Write updated lock file
                await this.writeLockFile(lockFile);
            });

            Logger.log(`Registered instance: ${this.instanceId}`);
            return true;
        } catch (error) {
            Logger.error('Failed to register instance:', error);
            this.instanceId = null;
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
            await this.withLock(async () => {
                const lockFile = await this.readLockFile();

                // Remove this instance
                lockFile.instances = lockFile.instances.filter(
                    instance => instance.id !== this.instanceId
                );

                // Write updated lock file
                await this.writeLockFile(lockFile);
            });

            Logger.log(`Unregistered instance: ${this.instanceId}`);
            this.instanceId = null;
        } catch (error) {
            Logger.error('Failed to unregister instance:', error);
        }
    }

    /**
     * Get list of active instances
     */
    async getActiveInstances(): Promise<InstanceInfo[]> {
        try {
            const lockFile = await this.readLockFile();
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
            return await this.withLock(async () => {
                const lockFile = await this.readLockFile();
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
                    await this.writeLockFile(lockFile);
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
        if (!this.instanceId) {
            return;
        }

        try {
            await this.withLock(async () => {
                const lockFile = await this.readLockFile();

                // Find and update this instance's heartbeat
                for (const instance of lockFile.instances) {
                    if (instance.id === this.instanceId) {
                        instance.lastHeartbeat = Date.now();
                        break;
                    }
                }

                await this.writeLockFile(lockFile);
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
     * Ensure the sync directory exists
     */
    private async ensureSyncDir(): Promise<void> {
        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }
    }

    /**
     * Read the lock file
     */
    private async readLockFile(): Promise<InstancesLockFile> {
        try {
            if (!fs.existsSync(this.lockFilePath)) {
                return { schemaVersion: SCHEMA_VERSION, instances: [] };
            }

            const content = fs.readFileSync(this.lockFilePath, 'utf-8');
            if (!content || content.trim() === '') {
                return { schemaVersion: SCHEMA_VERSION, instances: [] };
            }

            return JSON.parse(content) as InstancesLockFile;
        } catch (error) {
            Logger.warn('Failed to read lock file, creating new one:', error);
            return { schemaVersion: SCHEMA_VERSION, instances: [] };
        }
    }

    /**
     * Write the lock file atomically
     */
    private async writeLockFile(lockFile: InstancesLockFile): Promise<void> {
        const tempPath = `${this.lockFilePath}.${this.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        const content = JSON.stringify(lockFile, null, 2);

        // Write to temp file first
        fs.writeFileSync(tempPath, content, 'utf-8');

        // Atomic rename with small retry to reduce Windows EPERM flakiness.
        try {
            const attempts = 5;
            for (let i = 0; i < attempts; i++) {
                try {
                    fs.renameSync(tempPath, this.lockFilePath);
                    return;
                } catch (error: any) {
                    const code = error?.code;
                    if ((code === 'EPERM' || code === 'EACCES') && i < attempts - 1) {
                        await new Promise(resolve => setTimeout(resolve, MUTEX_RETRY_DELAY_MS));
                        continue;
                    }
                    throw error;
                }
            }
        } finally {
            // Best-effort cleanup if the rename did not happen.
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore
            }
        }
    }

    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureSyncDir();

        const start = Date.now();
        while (true) {
            try {
                // Use exclusive create as a cross-process mutex.
                const fd = fs.openSync(this.mutexFilePath, 'wx');
                fs.closeSync(fd);
                break;
            } catch (error: any) {
                if (error?.code !== 'EEXIST') {
                    throw error;
                }

                // If the mutex is stale (e.g., previous process crashed), remove it.
                try {
                    const stat = fs.statSync(this.mutexFilePath);
                    if (Date.now() - stat.mtimeMs > MUTEX_STALE_MS) {
                        fs.unlinkSync(this.mutexFilePath);
                        continue;
                    }
                } catch {
                    // If stat/unlink fails, just fall through to retry.
                }

                if (Date.now() - start > MUTEX_TIMEOUT_MS) {
                    throw new Error('Timed out acquiring instance registry mutex');
                }

                await new Promise(resolve => setTimeout(resolve, MUTEX_RETRY_DELAY_MS));
            }
        }

        try {
            return await fn();
        } finally {
            try {
                fs.unlinkSync(this.mutexFilePath);
            } catch {
                // ignore
            }
        }
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
