import type { AppliedProxyInfo } from '../config/SystemProxyDetector';
import { ProxyMode, type ProxyState } from './types';

/**
 * The currently applied proxy as echo suppression should see it: the active
 * Auto URL plus its detection provenance (issue #29). States saved before
 * 3.2.2 lack provenance; an engaged fallback is still unambiguous, so derive
 * it. Everything else stays undefined (= never suppressed) to protect
 * hand-set http.proxy values.
 */
export function appliedProxyInfoFromState(state: ProxyState): AppliedProxyInfo | undefined {
    if (state.mode !== ProxyMode.Auto || !state.autoProxyUrl) {
        return undefined;
    }
    let source: string | undefined = state.lastDetectionSource;
    if (!source && state.usingFallbackProxy && state.fallbackProxyUrl === state.autoProxyUrl) {
        source = 'fallback';
    }
    return { url: state.autoProxyUrl, source };
}
