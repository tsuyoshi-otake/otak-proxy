import { ProxyState } from '../core/types';
import { SharedState } from './SharedStateFile';
import { ConflictInfo, ConflictResolver, SyncableState } from './ConflictResolver';

export interface SyncReconciliationResult {
    conflictsResolved: number;
    currentState: SyncableState | null;
    remoteChange?: ProxyState;
    conflictDetails?: ConflictInfo;
    conflictLog?: string;
    reassertLocalState?: ProxyState;
    markSynced: boolean;
}

function isSameProxyState(a: ProxyState, b: ProxyState): boolean {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function createNoChangeResult(currentState: SyncableState | null): SyncReconciliationResult {
    return {
        conflictsResolved: 0,
        currentState,
        markSynced: false
    };
}

function toFileState(sharedState: SharedState): SyncableState {
    return {
        state: sharedState.proxyState,
        timestamp: sharedState.lastModified,
        instanceId: sharedState.lastModifiedBy,
        version: sharedState.version
    };
}

function isAlreadySynced(currentState: SyncableState, fileState: SyncableState): boolean {
    return fileState.version === currentState.version &&
        fileState.timestamp === currentState.timestamp &&
        isSameProxyState(currentState.state, fileState.state);
}

function createInitialRemoteResult(fileState: SyncableState, sharedState: SharedState): SyncReconciliationResult {
    return {
        conflictsResolved: 0,
        currentState: fileState,
        remoteChange: sharedState.proxyState,
        markSynced: true
    };
}

function createRemoteWinnerResult(
    resolution: ReturnType<ConflictResolver['resolve']>,
    sharedState: SharedState
): SyncReconciliationResult {
    const conflictsResolved = resolution.conflictDetails ? 1 : 0;

    return {
        conflictsResolved,
        currentState: resolution.resolvedState,
        remoteChange: sharedState.proxyState,
        conflictDetails: resolution.conflictDetails ?? undefined,
        conflictLog: resolution.conflictDetails ? 'Conflict resolved: remote state applied' : undefined,
        markSynced: true
    };
}

function createLocalWinnerResult(
    currentState: SyncableState,
    fileState: SyncableState,
    resolution: ReturnType<ConflictResolver['resolve']>
): SyncReconciliationResult {
    const shouldReassertLocal = !isSameProxyState(currentState.state, fileState.state);
    const conflictsResolved = resolution.conflictDetails ? 1 : 0;

    return {
        conflictsResolved,
        currentState,
        conflictDetails: resolution.conflictDetails ?? undefined,
        conflictLog: resolution.conflictDetails ? 'Conflict resolved: local state retained' : undefined,
        reassertLocalState: shouldReassertLocal ? currentState.state : undefined,
        markSynced: !shouldReassertLocal
    };
}

export function reconcileSharedState(
    sharedState: SharedState | null,
    localInstanceId: string | null,
    currentState: SyncableState | null,
    conflictResolver: ConflictResolver
): SyncReconciliationResult {
    if (!sharedState || !localInstanceId) {
        return createNoChangeResult(currentState);
    }

    const fileState = toFileState(sharedState);

    if (sharedState.lastModifiedBy === localInstanceId) {
        return createNoChangeResult(currentState ?? fileState);
    }

    if (currentState && isAlreadySynced(currentState, fileState)) {
        return createNoChangeResult(currentState);
    }

    if (!currentState) {
        return createInitialRemoteResult(fileState, sharedState);
    }

    const resolution = conflictResolver.resolve(currentState, fileState);

    if (resolution.winner === 'none') {
        return createNoChangeResult(currentState);
    }

    if (resolution.winner === 'remote') {
        return createRemoteWinnerResult(resolution, sharedState);
    }

    return createLocalWinnerResult(currentState, fileState, resolution);
}
