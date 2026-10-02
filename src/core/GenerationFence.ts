import { Logger } from '../utils/Logger';
import {
    LogicalGeneration,
    describeGeneration,
    isStaleGeneration
} from './LogicalGeneration';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from './ProxyApplierTypes';
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

export interface FenceCommit {
    outcome: FenceCommitResult;
    /**
     * Revision this call wrote. Known only through a compare-and-set commit;
     * undefined for the saveState fallback, where another writer may have
     * landed in between and the written revision cannot be attributed.
     */
    revision?: number;
}

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
    return (await commitUnlessStaleWithRevision(manager, started, owner, fold)).outcome;
}

/** {@link commitUnlessStale}, also reporting the revision this call wrote when it is attributable. */
export async function commitUnlessStaleWithRevision(
    manager: StateWriter,
    started: LogicalGeneration,
    owner: FenceOwner,
    fold: (current: ProxyState) => ProxyState | undefined
): Promise<FenceCommit> {
    const current = await manager.getState();
    if (isStaleGeneration(started, current)) {
        logStaleDiscard(owner, started, current);
        return { outcome: 'stale' };
    }

    const next = fold(current);
    if (!next) {
        return { outcome: 'unchanged' };
    }

    if (typeof manager.commitState === 'function') {
        const result = await manager.commitState(started.revision, next);
        if (result.kind === 'superseded') {
            logStaleDiscard(owner, started, result.current);
            return { outcome: 'stale' };
        }
        return { outcome: 'committed', revision: result.revision };
    }

    const latest = await manager.getState();
    if (isStaleGeneration(started, latest)) {
        logStaleDiscard(owner, started, latest);
        return { outcome: 'stale' };
    }

    await manager.saveState(next);
    return { outcome: 'committed' };
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

export type DetailedApply = (
    proxyUrl: string,
    enabled: boolean,
    options?: ProxyApplyOptions
) => Promise<ProxyApplyDetailedResult>;

/**
 * Wraps one apply request (first attempt plus remediation retries) in a
 * generation fence captured now.
 *
 * Every real apply commits its own per-target results, which advances the
 * revision by exactly one. Without rebasing, that self-commit makes the next
 * retry of the very same desired state look superseded, so remediation retries
 * silently became no-ops reported as success (#78).
 *
 * The fence follows only the commit the apply itself reports
 * (`committedRevision` = fence + 1, i.e. a compare-and-set at the fence
 * revision, which the result fold cannot change identity of). Observing
 * "revision +1 with the same identity" is not enough: when our own commit is
 * discarded, another writer's +1 (for example Auto turning OFF, which keeps the
 * mode and URLs) looks identical. Any revision movement the apply did not
 * report keeps the old fence, so later attempts are superseded.
 */
export function createFencedApply(
    manager: Pick<IProxyStateManager, 'getState'>,
    started: LogicalGeneration,
    owner: string,
    apply: DetailedApply
): DetailedApply {
    let fence = started;
    return async (proxyUrl, enabled, options) => {
        const current = await manager.getState();
        if (isStaleGeneration(fence, current)) {
            Logger.warn(
                `Discarding stale ${owner} apply/retry for a superseded generation ` +
                `(started ${describeGeneration(fence)}, current rev=${stateRevision(current)} mode=${current.mode}).`
            );
            return supersededApplyResult(proxyUrl, enabled);
        }

        const result = await apply(proxyUrl, enabled, options);
        if (result.committedRevision === fence.revision + 1) {
            fence = { ...fence, revision: result.committedRevision };
        }
        return result;
    };
}

function supersededApplyResult(proxyUrl: string, enabled: boolean): ProxyApplyDetailedResult {
    return {
        success: true,
        enabled,
        proxyUrl,
        results: {
            gitSuccess: true,
            vscodeSuccess: true,
            npmSuccess: true,
            terminalEnvSuccess: true
        },
        errors: [],
        superseded: true
    };
}
