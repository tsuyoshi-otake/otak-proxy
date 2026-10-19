import { ProxyMode, ProxyState } from '../core/types';
import { ProxyApplyTrigger } from './ProxyRemediationService';

export interface CredentialConsentReapplyDeps {
    getState: () => Promise<ProxyState>;
    getActiveProxyUrl: (state: ProxyState) => string;
    applyProxySafely: (url: string, enabled: boolean, trigger: ProxyApplyTrigger) => Promise<boolean>;
    updateStatusBar: (state: ProxyState) => void;
}

/**
 * Applies the then-current state after the user allowed a credential write.
 *
 * The prompt may be answered long after it was shown, so nothing captured at
 * that time is reused: the state is read now. It does nothing unless the
 * proxy is still on and still waiting for this consent, which is how a toggle
 * to Off, or an apply that already succeeded in between, cancels the answer.
 * The apply is one non-silent attempt; the status bar is then refreshed from a
 * fresh read because the apply itself publishes nothing.
 */
export async function reapplyAfterCredentialConsent(deps: CredentialConsentReapplyDeps): Promise<void> {
    const state = await deps.getState();
    if (state.mode === ProxyMode.Off || state.applyBlocked !== 'credentialConsent') {
        return;
    }
    const url = deps.getActiveProxyUrl(state);
    if (!url) {
        return;
    }
    await deps.applyProxySafely(url, true, 'credentialConsent');
    deps.updateStatusBar(await deps.getState());
}
