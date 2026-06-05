import { ProxyState } from '../core/types';

/**
 * Result of a sync operation.
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
 * Current sync status.
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
 * Interface for SyncManager as defined in design.md.
 */
export interface ISyncManager {
    /**
     * Start the sync service.
     * @returns True if started successfully
     */
    start(): Promise<boolean>;

    /**
     * Stop the sync service.
     */
    stop(): Promise<void>;

    /**
     * Notify other instances of a state change.
     * @param state The new proxy state
     */
    notifyChange(state: ProxyState): Promise<void>;

    /**
     * Manually trigger a sync.
     */
    triggerSync(): Promise<SyncResult>;

    /**
     * Get current sync status.
     */
    getSyncStatus(): SyncStatus;

    /**
     * Get the last shared proxy state loaded or written by this manager.
     */
    getCurrentSharedState(): ProxyState | null;

    /**
     * Check if sync is enabled.
     */
    isEnabled(): boolean;
}
