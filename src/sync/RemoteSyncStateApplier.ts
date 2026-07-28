import { ProxyMode, ProxyState } from '../core/types';

export interface RemoteSyncApplyContext {
    saveState(state: ProxyState): Promise<void>;
    getState(): Promise<ProxyState>;
    getActiveProxyUrl(state: ProxyState): string;
    applyProxy(url: string, enabled: boolean): Promise<boolean>;
    startMonitoring(): Promise<void>;
    stopMonitoring(): Promise<void>;
    updateStatus(state: ProxyState): void;
    onApplyFailure?(): void;
}

/**
 * Applies a remote desired state to this window. Auto OFF is an explicit local
 * disable terminal state, not an empty-URL no-op. The returned boolean lets the
 * caller observe convergence failure even when user notifications are silent.
 */
export async function applyRemoteSyncState(
    remoteState: ProxyState,
    context: RemoteSyncApplyContext
): Promise<boolean> {
    await context.saveState(remoteState);
    const localState = await context.getState();
    const activeUrl = context.getActiveProxyUrl(localState);
    const shouldEnable = localState.mode !== ProxyMode.Off && Boolean(activeUrl);
    const applied = await context.applyProxy(shouldEnable ? activeUrl : '', shouldEnable);

    if (localState.mode === ProxyMode.Auto) {
        await context.startMonitoring();
    } else {
        await context.stopMonitoring();
    }

    context.updateStatus(await context.getState());
    if (!applied) {
        context.onApplyFailure?.();
    }
    return applied;
}
