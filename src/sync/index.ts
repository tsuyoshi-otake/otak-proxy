/**
 * @file sync/index.ts
 * @description Exports for multi-instance synchronization module
 *
 * Feature: multi-instance-sync
 */

export { SyncManager, ISyncManager, SyncResult, SyncStatus } from './SyncManager';
export { SyncConfigManager, ISyncConfigManager } from './SyncConfigManager';
export { SharedStateFile, ISharedStateFile, SharedState } from './SharedStateFile';
export { InstanceRegistry, IInstanceRegistry, InstanceInfo } from './InstanceRegistry';
export { FileWatcher, IFileWatcher } from './FileWatcher';
export { ConflictResolver, SyncableState, ConflictResolution, ConflictInfo } from './ConflictResolver';
export { SyncStatusProvider, ISyncStatusProvider, SyncDisplayState, registerSyncStatusCommand } from './SyncStatusProvider';
