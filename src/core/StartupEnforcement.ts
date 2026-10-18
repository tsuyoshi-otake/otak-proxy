import { splitRoutingIdentity } from '../config/DetectedProxyValue';
import { ProxyState } from './types';

/**
 * A stable signature of every input applyStartupProxyState reads — no
 * bookkeeping. Used to detect whether the persisted state changed while the
 * (slow) startup enforcement ran, so we can reconcile on the latest instead
 * of a stale activation snapshot (#12). requiresAuth, authRequiredProxyUrls
 * and the split fields are inputs (the unauthenticated-apply skip and the
 * write plan read them), so a change in them alone re-runs (#108).
 */
function startupEnforcementTarget(
    state: ProxyState,
    getActiveProxyUrl: (state: ProxyState) => string
): string {
    return JSON.stringify({
        mode: state.mode,
        activeUrl: getActiveProxyUrl(state),
        autoModeOff: state.autoModeOff === true,
        requiresAuth: state.requiresAuth === true,
        authRequiredProxyUrls: state.authRequiredProxyUrls ?? [],
        splitRouting: splitRoutingIdentity(state),
        noProxy: state.noProxy ?? ''
    });
}

/**
 * Runs the startup apply until the persisted state stops changing under it
 * (bounded). The comparison is on user-relevant identity only: the apply's own
 * result commit moves the revision, which must not count as a change (#78).
 * Returns the final target, or undefined when the activation was superseded.
 */
export async function reconcileStartupProxyApply(
    state: ProxyState,
    getActiveProxyUrl: (state: ProxyState) => string,
    apply: (target: ProxyState, attempt: number) => Promise<void>,
    getState: () => Promise<ProxyState>,
    isCurrent: () => boolean
): Promise<ProxyState | undefined> {
    let target = state;
    for (let attempt = 0; attempt < 3; attempt++) {
        await apply(target, attempt);
        if (!isCurrent()) {
            return undefined;
        }
        const latest = await getState();
        const stable =
            startupEnforcementTarget(latest, getActiveProxyUrl) ===
            startupEnforcementTarget(target, getActiveProxyUrl);
        target = latest;
        if (stable) {
            return target;
        }
    }
    return isCurrent() ? target : undefined;
}
