/**
 * @file SyncManager
 * @description Central coordinator for multi-instance synchronization
 *
 * Feature: multi-instance-sync
 * Requirements: 1.1-1.4, 2.1-2.5, 3.1-3.3, 7.1-7.5
 *
 * Provides:
 * - Instance lifecycle management
 * - State change propagation
 * - Remote change detection and application
 * - Error handling and recovery
 */

import { EventEmitter } from 'events';
import { ProxyState } from '../core/types';
import { Logger } from '../utils/Logger';
import { SharedStateFile, SharedState, ISharedStateFile } from './SharedStateFile';
import { InstanceRegistry, IInstanceRegistry } from './InstanceRegistry';
import { FileWatcher, IFileWatcher } from './FileWatcher';
import { ConflictResolver, SyncableState, ConflictInfo } from './ConflictResolver';
import { ISyncConfigManager } from './SyncConfigManager';

/**
 * Result of a sync operation
 */
export interface SyncResult {
    /** Whether sync succeeded */
    success: boolean;
    /** Number of instances notified */
    instancesNotified: number;
    /** Number of conflicts resolved */
    conflictsResolved: number;
    /** Error message if failed */
    error?: string;
}

/**
 * Current sync status
 */
export interface SyncStatus {
    /** Whether sync is enabled */
    enabled: boolean;
    /** Number of active instances */
    activeInstances: number;
    /** Last successful sync timestamp */
    lastSyncTime: number | null;
    /** Last error message */
    lastError: string | null;
    /** Whether currently syncing */
    isSyncing: boolean;
}

/**
 * Interface for SyncManager as defined in design.md
 */
export interface ISyncManager {
    /**
     * Start the sync service
     * @returns True if started successfully
     */
    start(): Promise<boolean>;

    /**
     * Stop the sync service
     */
    stop(): Promise<void>;

    /**
     * Notify other instances of a state change
     * @param state The new proxy state
     */
    notifyChange(state: ProxyState): Promise<void>;

    /**
     * Manually trigger a sync
     */
    triggerSync(): Promise<SyncResult>;

    /**
     * Get current sync status
     */
    getSyncStatus(): SyncStatus;

    /**
     * Check if sync is enabled
     */
    isEnabled(): boolean;
}

/**
 * Heartbeat interval in milliseconds (10 seconds)
 */
const HEARTBEAT_INTERVAL = 10000;

/**
 * Cleanup interval in milliseconds (30 seconds)
 */
const CLEANUP_INTERVAL = 30000;

/**
 * SyncManager coordinates synchronization between multiple otak-proxy instances.
 *
 * Architecture:
 * - Uses SharedStateFile for persistent state storage
 * - Uses InstanceRegistry for tracking active instances
 * - Uses FileWatcher for detecting remote changes
 * - Uses ConflictResolver for handling concurrent updates
 */
export class SyncManager extends EventEmitter implements ISyncManager {
    private readonly sharedStateFile: ISharedStateFile;
    private readonly instanceRegistry: IInstanceRegistry;
    private readonly fileWatcher: IFileWatcher;
    private readonly conflictResolver: ConflictResolver;
    private readonly configManager: ISyncConfigManager;
    private readonly windowId: string;

    private isStarted: boolean = false;
    private isSyncing: boolean = false;
    private lastSyncTime: number | null = null;
    private lastError: string | null = null;
    private currentState: SyncableState | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;

    /**
     * Create a new SyncManager
     *
     * @param baseDir Base directory for sync files
     * @param windowId VSCode window identifier
     * @param configManager Configuration manager
     */
    constructor(
        baseDir: string,
        windowId: string,
        configManager: ISyncConfigManager
    ) {
        super();

        this.windowId = windowId;
        this.configManager = configManager;

        // Initialize components
        this.sharedStateFile = new SharedStateFile(baseDir);
        this.instanceRegistry = new InstanceRegistry(baseDir, windowId);
        this.fileWatcher = new FileWatcher();
        this.conflictResolver = new ConflictResolver();

        // Set up file change handler
        this.fileWatcher.on('change', () => this.handleRemoteChange());

        // Set up config change handler
        this.configManager.onConfigChange((key, value) => {
            this.handleConfigChange(key, value);
        });
    }

    /**
     * Start the sync service
     *
     * @returns True if started successfully
     */
    async start(): Promise<boolean> {
        // Check if sync is enabled in configuration
        if (!this.configManager.isSyncEnabled()) {
            Logger.log('Sync is disabled in configuration, running in standalone mode');
            return true;
        }

        if (this.isStarted) {
            Logger.log('SyncManager already started');
            return true;
        }

        try {
            // Register this instance
            const registered = await this.instanceRegistry.register();
            if (!registered) {
                Logger.error('Failed to register instance');
                return false;
            }

            // Start file watcher
            const filePath = this.sharedStateFile.getFilePath();
            this.fileWatcher.start(filePath);

            // Start heartbeat timer
            this.heartbeatTimer = setInterval(() => {
                this.instanceRegistry.updateHeartbeat();
            }, HEARTBEAT_INTERVAL);

            // Start cleanup timer
            this.cleanupTimer = setInterval(() => {
                this.instanceRegistry.cleanup();
            }, CLEANUP_INTERVAL);

            // Load initial state
            await this.loadInitialState();

            this.isStarted = true;
            this.emitStatusChanged();

            Logger.log('SyncManager started successfully');
            return true;
        } catch (error) {
            Logger.error('Failed to start SyncManager:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            return false;
        }
    }

    /**
     * Stop the sync service
     */
    async stop(): Promise<void> {
        if (!this.isStarted) {
            return;
        }

        try {
            // Stop timers
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }

            if (this.cleanupTimer) {
                clearInterval(this.cleanupTimer);
                this.cleanupTimer = null;
            }

            // Stop file watcher
            this.fileWatcher.stop();

            // Unregister instance
            await this.instanceRegistry.unregister();

            this.isStarted = false;
            this.currentState = null;
            this.emitStatusChanged();

            Logger.log('SyncManager stopped');
        } catch (error) {
            Logger.error('Error stopping SyncManager:', error);
        }
    }

    /**
     * Notify other instances of a state change
     *
     * @param state The new proxy state
     */
    async notifyChange(state: ProxyState): Promise<void> {
        if (!this.isStarted || !this.configManager.isSyncEnabled()) {
            return;
        }

        try {
            const instanceId = (this.instanceRegistry as InstanceRegistry).getInstanceId();
            if (!instanceId) {
                return;
            }

            const now = Date.now();
            const version = this.currentState ? this.currentState.version + 1 : 1;

            // Create syncable state
            this.currentState = {
                state,
                timestamp: now,
                instanceId,
                version
            };

            // Write to shared state file
            const sharedState: SharedState = {
                version,
                lastModified: now,
                lastModifiedBy: instanceId,
                proxyState: state,
                testResult: state.lastTestResult
            };

            await this.sharedStateFile.write(sharedState);
            this.lastSyncTime = now;

            Logger.log(`State change propagated (version ${version})`);
        } catch (error) {
            Logger.error('Failed to notify state change:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
        }
    }

    /**
     * Manually trigger a sync
     */
    async triggerSync(): Promise<SyncResult> {
        if (this.isSyncing) {
            return {
                success: false,
                instancesNotified: 0,
                conflictsResolved: 0,
                error: 'Sync already in progress'
            };
        }

        this.isSyncing = true;
        this.emitStatusChanged();

        try {
            // Read shared state
            const sharedState = await this.sharedStateFile.read();

            // Get active instances
            const instances = await this.instanceRegistry.getActiveInstances();

            // Clean up zombies
            const cleaned = await this.instanceRegistry.cleanup();

            this.lastSyncTime = Date.now();
            this.lastError = null;

            return {
                success: true,
                instancesNotified: instances.length,
                conflictsResolved: cleaned
            };
        } catch (error) {
            Logger.error('Sync failed:', error);
            this.lastError = error instanceof Error ? error.message : String(error);

            return {
                success: false,
                instancesNotified: 0,
                conflictsResolved: 0,
                error: this.lastError
            };
        } finally {
            this.isSyncing = false;
            this.emitStatusChanged();
        }
    }

    /**
     * Get current sync status
     */
    getSyncStatus(): SyncStatus {
        return {
            enabled: this.isStarted,
            activeInstances: 0, // Will be updated asynchronously
            lastSyncTime: this.lastSyncTime,
            lastError: this.lastError,
            isSyncing: this.isSyncing
        };
    }

    /**
     * Check if sync is enabled
     */
    isEnabled(): boolean {
        return this.isStarted && this.configManager.isSyncEnabled();
    }

    /**
     * Handle remote state change detected by file watcher
     */
    private async handleRemoteChange(): Promise<void> {
        if (!this.isStarted || this.isSyncing) {
            return;
        }

        try {
            // Read the shared state
            const sharedState = await this.sharedStateFile.read();
            if (!sharedState) {
                return;
            }

            const instanceId = (this.instanceRegistry as InstanceRegistry).getInstanceId();

            // Skip if this is our own change
            if (sharedState.lastModifiedBy === instanceId) {
                return;
            }

            // Create remote syncable state
            const remoteState: SyncableState = {
                state: sharedState.proxyState,
                timestamp: sharedState.lastModified,
                instanceId: sharedState.lastModifiedBy,
                version: sharedState.version
            };

            // Resolve conflict if we have local state
            if (this.currentState) {
                const resolution = this.conflictResolver.resolve(this.currentState, remoteState);

                if (resolution.winner === 'remote') {
                    // Apply remote state
                    this.currentState = remoteState;
                    this.emit('remoteChange', sharedState.proxyState);

                    if (resolution.conflictDetails) {
                        this.emit('conflictResolved', resolution.conflictDetails);
                        Logger.log('Conflict resolved: remote state applied');
                    }
                }
            } else {
                // No local state, accept remote
                this.currentState = remoteState;
                this.emit('remoteChange', sharedState.proxyState);
            }

            this.lastSyncTime = Date.now();
        } catch (error) {
            Logger.error('Failed to handle remote change:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emit('syncError', error);
        }
    }

    /**
     * Load initial state from shared file
     */
    private async loadInitialState(): Promise<void> {
        try {
            const sharedState = await this.sharedStateFile.read();
            if (sharedState) {
                this.currentState = {
                    state: sharedState.proxyState,
                    timestamp: sharedState.lastModified,
                    instanceId: sharedState.lastModifiedBy,
                    version: sharedState.version
                };

                Logger.log('Loaded initial state from shared file');
            }
        } catch (error) {
            Logger.warn('Failed to load initial state:', error);
            // Not critical - we'll create state on first change
        }
    }

    /**
     * Handle configuration change
     */
    private handleConfigChange(key: string, value: unknown): void {
        if (key === 'syncEnabled') {
            if (value === false && this.isStarted) {
                Logger.log('Sync disabled via configuration, stopping...');
                this.stop();
            } else if (value === true && !this.isStarted) {
                Logger.log('Sync enabled via configuration, starting...');
                this.start();
            }
        }
    }

    /**
     * Emit status changed event
     */
    private emitStatusChanged(): void {
        this.emit('syncStateChanged', this.getSyncStatus());
    }
}
