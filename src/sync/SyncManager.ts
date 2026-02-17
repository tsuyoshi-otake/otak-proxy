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
import { ConflictResolver, SyncableState } from './ConflictResolver';
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
    /** Number of inactive instances removed from the registry (best-effort) */
    instancesCleaned?: number;
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

    private isStarted: boolean = false;
    private isSyncing: boolean = false;
    private activeInstances: number = 0;
    private lastSyncTime: number | null = null;
    private lastError: string | null = null;
    private currentState: SyncableState | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private syncTimer: NodeJS.Timeout | null = null;
    private remoteChangeInProgress: boolean = false;

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
        configManager: ISyncConfigManager,
        extensionVersion: string = 'unknown'
    ) {
        super();

        this.configManager = configManager;

        // Initialize components
        this.sharedStateFile = new SharedStateFile(baseDir);
        this.instanceRegistry = new InstanceRegistry(baseDir, windowId, extensionVersion);
        this.fileWatcher = new FileWatcher();
        this.conflictResolver = new ConflictResolver();

        // Set up file change handler
        this.fileWatcher.on('change', () => void this.handleRemoteChange());

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

            // Populate cached instance count for synchronous status reporting.
            await this.refreshActiveInstances();

            this.isStarted = true;
            this.reschedulePeriodicSync();
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

            this.stopPeriodicSync();

            // Stop file watcher
            this.fileWatcher.stop();

            // Unregister instance
            await this.instanceRegistry.unregister();

            this.isStarted = false;
            this.currentState = null;
            this.activeInstances = 0;
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
            const instanceId = this.instanceRegistry.getInstanceId();
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
            this.lastError = null;
            this.emitStatusChanged();

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
        if (this.isSyncing || this.remoteChangeInProgress) {
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
            const reconciliation = await this.reconcileWithSharedFile();

            // Get active instances
            const instances = await this.instanceRegistry.getActiveInstances();
            this.activeInstances = instances.length;

            // Clean up zombies
            const instancesCleaned = await this.instanceRegistry.cleanup();

            this.lastSyncTime = Date.now();
            this.lastError = null;

            return {
                success: true,
                instancesNotified: instances.length,
                conflictsResolved: reconciliation.conflictsResolved,
                instancesCleaned
            };
        } catch (error) {
            Logger.error('Sync failed:', error);
            this.lastError = error instanceof Error ? error.message : String(error);

            return {
                success: false,
                instancesNotified: 0,
                conflictsResolved: 0,
                instancesCleaned: 0,
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
            activeInstances: this.activeInstances,
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
        if (!this.isStarted || this.isSyncing || this.remoteChangeInProgress) {
            return;
        }

        this.remoteChangeInProgress = true;
        try {
            await this.reconcileWithSharedFile();
        } catch (error) {
            Logger.error('Failed to handle remote change:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emitStatusChanged();
            this.emit('syncError', error);
        } finally {
            this.remoteChangeInProgress = false;
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
                void this.stop();
            } else if (value === true && !this.isStarted) {
                Logger.log('Sync enabled via configuration, starting...');
                void this.start();
            }
            return;
        }

        if (key === 'syncInterval' && this.isStarted) {
            this.reschedulePeriodicSync();
        }
    }

    private isSameProxyState(a: ProxyState, b: ProxyState): boolean {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }

    private async reconcileWithSharedFile(): Promise<{ conflictsResolved: number }> {
        const sharedState = await this.sharedStateFile.read();
        if (!sharedState) {
            return { conflictsResolved: 0 };
        }

        const localInstanceId = this.instanceRegistry.getInstanceId();
        if (!localInstanceId) {
            return { conflictsResolved: 0 };
        }

        const fileState: SyncableState = {
            state: sharedState.proxyState,
            timestamp: sharedState.lastModified,
            instanceId: sharedState.lastModifiedBy,
            version: sharedState.version
        };

        // If the file reflects our own write, make sure we have a baseline local state and exit.
        if (sharedState.lastModifiedBy === localInstanceId) {
            if (!this.currentState) {
                this.currentState = fileState;
            }
            return { conflictsResolved: 0 };
        }

        // No local state yet - accept remote state.
        if (!this.currentState) {
            this.currentState = fileState;
            this.emit('remoteChange', sharedState.proxyState);
            this.lastSyncTime = Date.now();
            this.lastError = null;
            this.emitStatusChanged();
            return { conflictsResolved: 0 };
        }

        const resolution = this.conflictResolver.resolve(this.currentState, fileState);
        const conflictsResolved = resolution.conflictDetails ? 1 : 0;

        if (resolution.winner === 'remote') {
            this.currentState = resolution.resolvedState;
            this.emit('remoteChange', sharedState.proxyState);

            if (resolution.conflictDetails) {
                this.emit('conflictResolved', resolution.conflictDetails);
                Logger.log('Conflict resolved: remote state applied');
            }

            this.lastSyncTime = Date.now();
            this.lastError = null;
            this.emitStatusChanged();
            return { conflictsResolved };
        }

        // Local wins. If the file contains a different state, reassert local state so other instances converge.
        if (resolution.conflictDetails) {
            this.emit('conflictResolved', resolution.conflictDetails);
            Logger.log('Conflict resolved: local state retained');
        }

        if (!this.isSameProxyState(this.currentState.state, fileState.state)) {
            await this.notifyChange(this.currentState.state);
            return { conflictsResolved };
        }

        this.lastSyncTime = Date.now();
        this.lastError = null;
        this.emitStatusChanged();
        return { conflictsResolved };
    }

    /**
     * Emit status changed event
     */
    private emitStatusChanged(): void {
        this.emit('syncStateChanged', this.getSyncStatus());
    }

    private async refreshActiveInstances(): Promise<void> {
        try {
            const previous = this.activeInstances;
            const instances = await this.instanceRegistry.getActiveInstances();
            this.activeInstances = instances.length;
            if (this.isStarted && this.activeInstances !== previous) {
                this.emitStatusChanged();
            }
        } catch (error) {
            Logger.warn('Failed to refresh active instances:', error);
            // Keep the last known value (defaults to 0).
        }
    }

    private stopPeriodicSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    private reschedulePeriodicSync(): void {
        this.stopPeriodicSync();

        // Polling provides a reliable fallback when fs.watch misses events.
        const intervalMs = this.configManager.getSyncInterval();
        this.syncTimer = setInterval(() => {
            void this.handleRemoteChange();
            void this.refreshActiveInstances();
        }, intervalMs);
    }
}
