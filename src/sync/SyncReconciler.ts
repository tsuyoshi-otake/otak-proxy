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

export function reconcileSharedState(
    sharedState: SharedState | null,
    localInstanceId: string | null,
    currentState: SyncableState | null,
    conflictResolver: ConflictResolver
): SyncReconciliationResult {
    if (!sharedState || !localInstanceId) {
        return {
            conflictsResolved: 0,
            currentState,
            markSynced: false
        };
    }

    const fileState: SyncableState = {
        state: sharedState.proxyState,
        timestamp: sharedState.lastModified,
        instanceId: sharedState.lastModifiedBy,
        version: sharedState.version
    };

    if (sharedState.lastModifiedBy === localInstanceId) {
        return {
            conflictsResolved: 0,
            currentState: currentState ?? fileState,
            markSynced: false
        };
    }

    if (currentState &&
        fileState.version === currentState.version &&
        fileState.timestamp === currentState.timestamp &&
        isSameProxyState(currentState.state, fileState.state)) {
        return {
            conflictsResolved: 0,
            currentState,
            markSynced: false
        };
    }

    if (!currentState) {
        return {
            conflictsResolved: 0,
            currentState: fileState,
            remoteChange: sharedState.proxyState,
            markSynced: true
        };
    }

    const resolution = conflictResolver.resolve(currentState, fileState);

    if (resolution.winner === 'none') {
        return {
            conflictsResolved: 0,
            currentState,
            markSynced: false
        };
    }

    const conflictsResolved = resolution.conflictDetails ? 1 : 0;

    if (resolution.winner === 'remote') {
        return {
            conflictsResolved,
            currentState: resolution.resolvedState,
            remoteChange: sharedState.proxyState,
            conflictDetails: resolution.conflictDetails ?? undefined,
            conflictLog: resolution.conflictDetails ? 'Conflict resolved: remote state applied' : undefined,
            markSynced: true
        };
    }

    const shouldReassertLocal = !isSameProxyState(currentState.state, fileState.state);
    return {
        conflictsResolved,
        currentState,
        conflictDetails: resolution.conflictDetails ?? undefined,
        conflictLog: resolution.conflictDetails ? 'Conflict resolved: local state retained' : undefined,
        reassertLocalState: shouldReassertLocal ? currentState.state : undefined,
        markSynced: !shouldReassertLocal
    };
}
