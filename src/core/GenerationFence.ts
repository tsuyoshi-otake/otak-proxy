import { Logger } from '../utils/Logger';
import { LogicalGeneration, describeGeneration, isStaleGeneration } from './LogicalGeneration';
import { IProxyStateManager, ProxyState, StateCommitResult, stateRevision } from './types';

export type FenceOwner =
    | 'detection'
    | 'connectionTest'
    | 'autoMonitoring'
    | 'stateChanged'
    | 'applyResults'
    | 'retry'
    | 'remediation'
    | 'startup'
    | 'sync'
    | 'remoteState'
    | 'diagnostics'
    | 'toggle'
    | 'initialSetup';

export type FenceCommitResult = 'committed' | 'stale' | 'unchanged';

export type StateWriter = Pick<IProxyStateManager, 'getState' | 'saveState'> & {
    commitState?: (expectedRevision: number, next: ProxyState) => Promise<StateCommitResult>;
};

/**
 * Drops a completion whose generation no longer matches stored state.
 * Callers must capture `started` before the async work, not at completion.
 */
export async function commitUnlessStale(
    manager: StateWriter,
    started: LogicalGeneration,
    owner: FenceOwner,
    fold: (current: ProxyState) => ProxyState | undefined
): Promise<FenceCommitResult> {
    const current = await manager.getState();
    if (isStaleGeneration(started, current)) {
        logStaleDiscard(owner, started, current);
        return 'stale';
    }

    const next = fold(current);
    if (!next) {
        return 'unchanged';
    }

    if (typeof manager.commitState === 'function') {
        const result = await manager.commitState(started.revision, next);
        if (result.kind === 'superseded') {
            logStaleDiscard(owner, started, result.current);
            return 'stale';
        }
        return 'committed';
    }

    const latest = await manager.getState();
    if (isStaleGeneration(started, latest)) {
        logStaleDiscard(owner, started, latest);
        return 'stale';
    }

    await manager.saveState(next);
    return 'committed';
}

export function logStaleDiscard(owner: FenceOwner, started: LogicalGeneration, current: ProxyState): void {
    Logger.warn(
        `Discarding stale ${owner} completion ` +
        `(started ${describeGeneration(started)}, current rev=${stateRevision(current)} mode=${current.mode}).`
    );
}

export async function publishUnlessStale(
    publish: ((state: ProxyState) => Promise<void>) | undefined,
    started: LogicalGeneration,
    owner: FenceOwner,
    current: ProxyState
): Promise<boolean> {
    if (!publish) {
        return false;
    }

    if (isStaleGeneration(started, current)) {
        logStaleDiscard(owner, started, current);
        return false;
    }

    try {
        await publish(current);
        return true;
    } catch (error) {
        Logger.warn('Failed to publish proxy state:', error);
        return false;
    }
}
