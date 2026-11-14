import { Logger } from '../utils/Logger';
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
 * In-memory ownership of a `convergencePending` flag. The flag rides the
 * shared/persisted state, so it cannot name the apply that set it; the claim
 * lives here instead, keyed by the per-window object every apply channel
 * shares (the extension context). When a second apply commits the flag for
 * the same logical identity, its claim replaces the first's — and the first
 * apply's clear, retried or not, then sees a foreign claim and leaves the
 * flag and the unpublished state alone (#135).
 */
const pendingClaims = new WeakMap<object, ConvergencePendingClaim>();

/** Opaque ownership of one apply's `convergencePending` commit. */
export interface ConvergencePendingClaim {
    readonly key: object;
    readonly prev: ConvergencePendingClaim | undefined;
}

/**
 * Claims the flag the caller is about to commit for `key` — the apply's own
 * channel key (the extension context). Claim before the pending commit so a
 * commit that never lands can be released back to the claim it displaced.
 */
export function claimConvergencePending(key: object): ConvergencePendingClaim {
    const claim: ConvergencePendingClaim = { key, prev: pendingClaims.get(key) };
    pendingClaims.set(key, claim);
    return claim;
}

/**
 * Gives back a claim the owning apply no longer needs — a pending commit
 * that lost its race, or a flag its clear consumed. Releasing restores the
 * claim it displaced, so an earlier apply's flag is not orphaned by a commit
 * that never landed. Releasing a claim a newer one already replaced is a
 * no-op.
 */
export function releaseConvergencePending(claim: ConvergencePendingClaim): void {
    if (pendingClaims.get(claim.key) !== claim) {
        return;
    }
    if (claim.prev) {
        pendingClaims.set(claim.key, claim.prev);
    } else {
        pendingClaims.delete(claim.key);
    }
}

/**
 * Attempts to clear the pending flag. Each one is a read and a compare-and-set
 * on that read, so a loss means a commit landed between the two.
 */
const CLEAR_PENDING_MAX_ATTEMPTS = 3;

/**
 * Ends an apply that started from a state saved with convergencePending:
 * clears the flag and publishes the converged state. A state that moved to
 * another logical identity meanwhile belongs to the writer that moved it: it
 * is neither cleared nor published here, at the clear or at the publish.
 *
 * The decision follows the logical identity, never the revision: the apply
 * itself writes the Configured flags, and a connection-test result or another
 * apply's results advance the revision without changing what the state means.
 * A clear that loses to such a commit re-reads and tries again, at most
 * CLEAR_PENDING_MAX_ATTEMPTS times (a local re-read, so no timers). When every
 * attempt loses, the flag stays set and a warning says so: the call ends, the
 * state is never published as converged, and the next apply's own clear owns
 * the flag.
 *
 * `pendingClaim` is the apply's own claim on the flag (`claimConvergencePending`
 * where the flag was committed). The clear only proceeds while that claim is
 * still the current one: a second apply whose pending commit landed meanwhile
 * claimed the flag instead, and clearing or publishing over it would release a
 * still-applying state as converged. The claim is checked again inside the
 * fold, right before the compare-and-set, so a claim lost mid-commit reports
 * 'unchanged' and the call leaves the flag alone.
 */
export async function clearPendingThenPublish(
    context: ApplyConvergenceContext,
    owner: FenceOwner,
    desired: ProxyState,
    pendingClaim?: ConvergencePendingClaim
): Promise<void> {
    try {
        const manager = context.proxyStateManager;
        const afterApply = await manager.getState();
        const desiredIdentity = captureLogicalGeneration({ ...desired, revision: afterApply.revision });
        const stillDesired = (state: ProxyState): boolean =>
            sameLogicalIdentity(desiredIdentity, captureLogicalGeneration(state));
        // No claim means a call site that cleared before ownership tracking:
        // it stays allowed. A claim checks the map, so a flag another apply
        // claimed meanwhile is left to that apply's own clear.
        const ownsPendingFlag = (): boolean =>
            pendingClaim === undefined || pendingClaims.get(pendingClaim.key) === pendingClaim;

        let latest = afterApply;
        let cleared = false;
        for (let attempt = 0; attempt < CLEAR_PENDING_MAX_ATTEMPTS && !cleared; attempt++) {
            if (attempt > 0) {
                latest = await manager.getState();
            }
            if (!stillDesired(latest) || !ownsPendingFlag()) {
                return;
            }

            const outcome = await commitUnlessStale(
                manager,
                captureLogicalGeneration(latest),
                owner,
                current => (ownsPendingFlag() ? { ...current, convergencePending: false } : undefined)
            );
            if (outcome === 'unchanged') {
                // The claim was lost between the guard and the commit: the
                // flag now belongs to another apply, and retrying would only
                // see the same foreign claim.
                return;
            }
            cleared = outcome !== 'stale';
        }
        if (!cleared) {
            Logger.warn(
                `Could not clear convergencePending after ${CLEAR_PENDING_MAX_ATTEMPTS} attempts ` +
                `(${owner}): the state kept changing; it stays pending and is not published.`
            );
            return;
        }

        const published = await manager.getState();
        if (!stillDesired(published)) {
            return;
        }
        await publishUnlessStale(
            context.publishProxyState,
            captureLogicalGeneration(published),
            owner,
            published
        );
    } finally {
        if (pendingClaim) {
            releaseConvergencePending(pendingClaim);
        }
    }
}

/**
 * Publishes a state a command just committed. A state flagged
 * convergencePending belongs to the writer whose apply is still running: that
 * writer publishes once it converged, from a re-read that includes this
 * commit, so nothing unapplied is published as converged. A publish failure is
 * logged, not thrown: the commit stands.
 */
export async function publishCommitted(
    publish: ((state: ProxyState) => Promise<void>) | undefined,
    committed: ProxyState
): Promise<void> {
    if (!publish || committed.convergencePending) {
        return;
    }

    try {
        await publish(committed);
    } catch (error) {
        Logger.warn('Failed to publish proxy state:', error);
    }
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
 * What a caller decided: the fields it sets, or a function of the latest state
 * for a patch that derives a field from other fields (credential bookkeeping
 * follows the URLs, a mode change follows the current mode). A function is
 * evaluated again on every state the patch is folded onto.
 */
export type DecidedPatch = Partial<ProxyState> | ((latest: ProxyState) => Partial<ProxyState>);

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
    patch: DecidedPatch,
    stillValid: (latest: ProxyState) => boolean
): Promise<DecidedPatchOutcome> {
    for (let attempt = 0; attempt < DECIDED_PATCH_MAX_ATTEMPTS; attempt++) {
        const latest = await writer.getState();
        if (!stillValid(latest)) {
            return { kind: 'moved', state: latest };
        }

        const decided = typeof patch === 'function' ? patch(latest) : patch;
        const next: ProxyState = { ...latest };
        for (const key of Object.keys(decided) as (keyof ProxyState)[]) {
            const value = decided[key];
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
