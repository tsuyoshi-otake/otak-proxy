/**
 * @file ConflictResolver
 * @description Resolves conflicts when multiple instances change settings simultaneously
 *
 * Feature: multi-instance-sync
 * Requirements: 4.1, 4.2, 4.3, 4.4
 *
 * Conflict Resolution Strategy:
 * - Timestamp-based: Latest change wins
 * - Deterministic: Same timestamps -> remote wins
 * - Future timestamps are rejected (clock drift protection)
 */

import { ProxyState } from '../core/types';
import { Logger } from '../utils/Logger';

/**
 * State that can be synchronized between instances
 */
export interface SyncableState {
    /** The proxy state to sync */
    state: ProxyState;
    /** Unix timestamp (ms) when this state was created */
    timestamp: number;
    /** ID of the instance that created this state */
    instanceId: string;
    /** Version number for optimistic locking */
    version: number;
}

/**
 * Information about a detected conflict
 */
export interface ConflictInfo {
    /** Local state timestamp */
    localTimestamp: number;
    /** Remote state timestamp */
    remoteTimestamp: number;
    /** Local instance ID */
    localInstanceId: string;
    /** Remote instance ID */
    remoteInstanceId: string;
    /** Type of conflict */
    conflictType: 'simultaneous' | 'stale';
}

/**
 * Result of conflict resolution
 */
export interface ConflictResolution {
    /** Which state won the conflict */
    winner: 'local' | 'remote';
    /** The resolved state to use */
    resolvedState: SyncableState;
    /** Conflict details if a real conflict occurred, null if just an update */
    conflictDetails: ConflictInfo | null;
}

/**
 * Maximum allowed clock drift in milliseconds (30 seconds)
 * Timestamps beyond this in the future are considered invalid
 */
const MAX_CLOCK_DRIFT_MS = 30000;

/**
 * ConflictResolver handles conflicts between local and remote state changes.
 *
 * Resolution rules:
 * 1. Newer timestamp wins (Requirement 4.1)
 * 2. If timestamps are equal, remote wins (deterministic, Requirement 4.4)
 * 3. Future timestamps beyond MAX_CLOCK_DRIFT_MS are rejected
 * 4. Same instance updates are not considered conflicts
 */
export class ConflictResolver {
    /**
     * Resolve conflict between local and remote states
     *
     * @param local - Local instance state
     * @param remote - Remote instance state
     * @returns Resolution result with winner and conflict details
     */
    resolve(local: SyncableState, remote: SyncableState): ConflictResolution {
        const now = Date.now();

        // Check if this is from the same instance (not a real conflict)
        const sameInstance = local.instanceId === remote.instanceId;

        // Validate timestamps - reject future timestamps
        const localValid = this.isValidTimestamp(local.timestamp, now);
        const remoteValid = this.isValidTimestamp(remote.timestamp, now);

        // If remote timestamp is invalid (too far in the future), local wins
        if (!remoteValid && localValid) {
            Logger.warn(`Rejecting remote state with future timestamp: ${remote.timestamp}`);
            return {
                winner: 'local',
                resolvedState: local,
                conflictDetails: sameInstance ? null : this.createConflictDetails(local, remote, 'stale')
            };
        }

        // If local timestamp is invalid (too far in the future), remote wins
        if (!localValid && remoteValid) {
            Logger.warn(`Rejecting local state with future timestamp: ${local.timestamp}`);
            return {
                winner: 'remote',
                resolvedState: remote,
                conflictDetails: sameInstance ? null : this.createConflictDetails(local, remote, 'stale')
            };
        }

        // Compare timestamps
        if (remote.timestamp > local.timestamp) {
            // Remote is newer - remote wins
            return {
                winner: 'remote',
                resolvedState: remote,
                conflictDetails: sameInstance ? null : this.createConflictDetails(local, remote, 'stale')
            };
        } else if (local.timestamp > remote.timestamp) {
            // Local is newer - local wins
            return {
                winner: 'local',
                resolvedState: local,
                conflictDetails: sameInstance ? null : this.createConflictDetails(local, remote, 'stale')
            };
        } else {
            // Timestamps are equal - remote wins (deterministic rule)
            // This ensures all instances arrive at the same resolution
            return {
                winner: 'remote',
                resolvedState: remote,
                conflictDetails: sameInstance ? null : this.createConflictDetails(local, remote, 'simultaneous')
            };
        }
    }

    /**
     * Check if a timestamp is valid (not too far in the future)
     *
     * @param timestamp - Timestamp to validate
     * @param now - Current time
     * @returns True if valid, false if too far in the future
     */
    private isValidTimestamp(timestamp: number, now: number): boolean {
        // Allow some clock drift, but not too much
        return timestamp <= now + MAX_CLOCK_DRIFT_MS;
    }

    /**
     * Create conflict details for logging and notification
     *
     * @param local - Local state
     * @param remote - Remote state
     * @param conflictType - Type of conflict
     * @returns Conflict information
     */
    private createConflictDetails(
        local: SyncableState,
        remote: SyncableState,
        conflictType: 'simultaneous' | 'stale'
    ): ConflictInfo {
        return {
            localTimestamp: local.timestamp,
            remoteTimestamp: remote.timestamp,
            localInstanceId: local.instanceId,
            remoteInstanceId: remote.instanceId,
            conflictType
        };
    }
}
