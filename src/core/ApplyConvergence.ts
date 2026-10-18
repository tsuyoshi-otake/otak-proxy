import { commitUnlessStale, FenceOwner, publishUnlessStale, StateWriter } from './GenerationFence';
import { captureLogicalGeneration, sameLogicalIdentity } from './LogicalGeneration';
import { ProxyState } from './types';

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
