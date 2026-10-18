import { commitUnlessStale, FenceOwner, publishUnlessStale, StateWriter } from './GenerationFence';
import { captureLogicalGeneration, sameLogicalIdentity } from './LogicalGeneration';
import { ProxyState, StateCommitResult, stateRevision } from './types';

/**
 * The narrow seam an apply-and-converge path needs: a revision-checked state
 * writer plus the optional shared-state publish. Both InitializerContext (the
 * detection/monitor handlers) and the command layer's CommandContext can adapt
 * to it.
 */
export interface ApplyConvergenceContext {
    proxyStateManager: StateWriter;
    publishProxyState?: (state: ProxyState) => Promise<void>;
}

/**
 * Ends an apply that started from a state saved with convergencePending:
 * clears the flag and publishes the converged state. A state that moved to
 * another logical identity meanwhile belongs to the writer that moved it.
 * The revision is not compared: the apply itself writes the Configured flags.
 */
export async function clearPendingThenPublish(
    context: ApplyConvergenceContext,
    owner: FenceOwner,
    desired: ProxyState
): Promise<void> {
    const afterApply = await context.proxyStateManager.getState();
    const desiredIdentity = captureLogicalGeneration({ ...desired, revision: afterApply.revision });
    if (!sameLogicalIdentity(desiredIdentity, captureLogicalGeneration(afterApply))) {
        return;
    }

    const cleared = await commitUnlessStale(
        context.proxyStateManager,
        captureLogicalGeneration(afterApply),
        owner,
        current => ({ ...current, convergencePending: false })
    );
    if (cleared === 'stale') {
        return;
    }

    const published = await context.proxyStateManager.getState();
    await publishUnlessStale(
        context.publishProxyState,
        captureLogicalGeneration(published),
        owner,
        published
    );
}

/**
 * A writer that can check the stored revision before writing. Both
 * ProxyStateManager (the initializer's manager) and the command layer's
 * commitProxyState adapt to it.
 */
export interface DecidedPatchWriter {
    getState: () => Promise<ProxyState>;
    commitState: (expectedRevision: number, next: ProxyState) => Promise<StateCommitResult>;
}

/**
 * How a decided patch landed on the latest state:
 * - `committed`: the patch is stored; `state` is what was committed.
 * - `moved`: the guard rejected the latest state; nothing was written and
 *   `state` is that latest state, so the caller decides again or yields.
 * - `exhausted`: every compare-and-set attempt lost the race and a final
 *   guarded read still passes the guard (only writers the guard accepts,
 *   such as revision-only bookkeeping, won every attempt); the caller may
 *   report a real failure. A last-attempt loss to a writer that moved the
 *   state is reported as `moved`, never `exhausted`.
 */
export type DecidedPatchOutcome =
    | { kind: 'committed'; state: ProxyState }
    | { kind: 'moved'; state: ProxyState }
    | { kind: 'exhausted' };

const DECIDED_PATCH_MAX_ATTEMPTS = 3;

/**
 * Fields that differ between `before` and `after`, over the union of their
 * keys. A field present in `before` but absent in `after` is carried as
 * `undefined` so the patch deletes it instead of silently keeping it.
 */
export function diffProxyState(before: ProxyState, after: ProxyState): Partial<ProxyState> {
    const patch: Partial<ProxyState> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        const field = key as keyof ProxyState;
        if (before[field] !== after[field]) {
            (patch as Record<keyof ProxyState, unknown>)[field] = after[field];
        }
    }
    return patch;
}

/**
 * Folds a patch a caller already decided onto the latest stored state. Each
 * attempt re-reads: when the guard rejects (another writer owns the state or
 * its identity moved), nothing is written; when the compare-and-set loses the
 * race, the patch is refolded onto the newer state so fields other writers
 * committed in between are kept. A patch key set to `undefined` removes the
 * field. When the attempts run out, one final guarded read decides between
 * `moved` (another writer owns the state) and `exhausted` (only writers the
 * guard accepts won every attempt: a real failure). No timers: a CAS refold
 * is not a network retry.
 */
export async function commitDecidedPatch(
    writer: DecidedPatchWriter,
    patch: Partial<ProxyState>,
    stillValid: (latest: ProxyState) => boolean
): Promise<DecidedPatchOutcome> {
    for (let attempt = 0; attempt < DECIDED_PATCH_MAX_ATTEMPTS; attempt++) {
        const latest = await writer.getState();
        if (!stillValid(latest)) {
            return { kind: 'moved', state: latest };
        }

        const next: ProxyState = { ...latest };
        for (const key of Object.keys(patch) as (keyof ProxyState)[]) {
            const value = patch[key];
            if (value === undefined) {
                delete next[key];
            } else {
                (next as Record<keyof ProxyState, unknown>)[key] = value;
            }
        }

        const result = await writer.commitState(stateRevision(latest), next);
        if (result.kind === 'committed') {
            return { kind: 'committed', state: result.state };
        }
    }

    // The last attempt may have lost to a writer that moved the state; a bare
    // 'exhausted' would misreport that as a failure. Re-check the guard once
    // more: 'exhausted' means every winning writer still passed the guard
    // (revision-only bookkeeping), not that the revision never moved. Read
    // through getState(), NOT the `current` a superseded result carries: the
    // stored state can lack hydrated credentials, and URL identity includes
    // them, so the payload would see a false identity move.
    const latest = await writer.getState();
    if (!stillValid(latest)) {
        return { kind: 'moved', state: latest };
    }
    return { kind: 'exhausted' };
}
