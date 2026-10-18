import { isPerSchemeProxy } from '../config/DetectedProxyValue';
import { hasProxyCredentials, removeProxyCredentials } from '../utils/ProxyStateSanitizer';
import { ProxyApplyOptions } from './ProxyApplierTypes';
import { ProxyState } from './types';

/**
 * The write plan for one apply attempt.
 *
 * A plan is the primary URL plus, when the committed state carries a
 * per-scheme split for it, the HTTP and HTTPS URLs and the bypass. It is
 * resolved once, before credential consent, from a single state read: the
 * URLs consent and policy judge are exactly the URLs the applier writes, and
 * retries reuse the same plan (#108). The applier never resolves a plan.
 */

/**
 * Turns caller options into the full write plan against one committed state
 * read. An already-explicit split or an explicit bypass is trusted as the
 * plan; otherwise a per-scheme state whose credential-free primary matches the
 * applied URL contributes the split, and the state's detected bypass is the
 * default.
 */
export function resolveProxyApplyOptions(
    proxyUrl: string,
    options: ProxyApplyOptions | undefined,
    state: ProxyState | undefined
): ProxyApplyOptions {
    if (isPerSchemeProxy(options?.kind, options?.httpUrl, options?.httpsUrl) || options?.bypass) {
        return options ?? {};
    }
    if (!state) {
        return options ?? {};
    }

    if (!isPerSchemeProxy(state.autoProxyKind, state.autoHttpProxyUrl, state.autoHttpsProxyUrl)) {
        return {
            ...options,
            bypass: options?.bypass ?? state.detectedBypass
        };
    }

    const primary = state.autoHttpProxyUrl || state.autoProxyUrl;
    const publicPrimary = primary ? (removeProxyCredentials(primary) || primary) : undefined;
    const publicApplied = removeProxyCredentials(proxyUrl) || proxyUrl;
    if (publicPrimary && publicPrimary !== publicApplied) {
        return options ?? {};
    }

    return {
        ...options,
        kind: 'perSchemeProxy',
        httpUrl: state.autoHttpProxyUrl,
        httpsUrl: state.autoHttpsProxyUrl,
        bypass: options?.bypass ?? state.detectedBypass
    };
}

/**
 * Every URL a plan writes to a target: the primary plus any per-scheme URLs,
 * deduplicated. This is the set consent and policy must judge (#108).
 */
export function proxyApplyPlanUrls(proxyUrl: string, options?: ProxyApplyOptions): string[] {
    const urls = [proxyUrl];
    if (isPerSchemeProxy(options?.kind, options?.httpUrl, options?.httpsUrl)) {
        urls.push(options!.httpUrl!, options!.httpsUrl!);
    }
    return [...new Set(urls.filter(url => Boolean(url)))];
}

/** The credential-bearing subset of {@link proxyApplyPlanUrls}. */
export function proxyApplyPlanCredentialUrls(proxyUrl: string, options?: ProxyApplyOptions): string[] {
    return proxyApplyPlanUrls(proxyUrl, options).filter(url => hasProxyCredentials(url));
}
