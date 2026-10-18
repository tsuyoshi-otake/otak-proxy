import { ProxyState, ProxyTestResult } from '../core/types';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { toPublicProxyHref } from './ProxyUrlIdentity';

const sanitizer = new InputSanitizer();
const redactor = new ProxySecretRedactor();

export function hasProxyCredentials(url: string): boolean {
    try {
        const parsed = new URL(url);
        return Boolean(parsed.username || parsed.password);
    } catch {
        return /\/\/[^/\s@]+@/.test(url);
    }
}

export function removeProxyCredentials(url: string | undefined): string | undefined {
    if (!url || !hasProxyCredentials(url)) {
        return url;
    }
    return sanitizer.removeCredentials(url);
}

export function getProxyPublicUrl(url: string | undefined): string | undefined {
    if (!url) {
        return url;
    }

    return toPublicProxyHref(url) ?? removeProxyCredentials(url);
}

function sanitizeOptionalMessage(message: string | undefined): string | undefined {
    if (!message) {
        return message;
    }
    // State error fields are arbitrary text, not a single display URL. Use the
    // strict redactor so username-only tokens and embedded credentials cannot
    // reach globalState or shared sync files.
    return redactor.redactString(message);
}

export function sanitizeProxyTestResultForPersistence(result: ProxyTestResult | undefined): ProxyTestResult | undefined {
    if (!result) {
        return result;
    }

    const sanitized: ProxyTestResult = {
        ...result,
        testUrls: result.testUrls.map(url => removeProxyCredentials(url) ?? url),
        errors: result.errors.map(error => ({
            url: removeProxyCredentials(error.url) ?? error.url,
            message: sanitizeOptionalMessage(error.message) ?? error.message
        }))
    };

    if ('proxyUrl' in result) {
        sanitized.proxyUrl = removeProxyCredentials(result.proxyUrl);
    }

    // In-memory generation stamps must never reach globalState or sync files.
    delete (sanitized as { startedGeneration?: unknown }).startedGeneration;

    return sanitized;
}

export const UNRESOLVED_LOCAL_CREDENTIAL_ERROR =
    'Proxy credentials are required but unavailable on this machine';

/**
 * The ProxyState fields that can hold a proxy URL. `proxyUrlsHaveCredentials`,
 * the `authRequiredProxyUrls` derivation and the unauthenticated-apply gate all
 * read this one list so they can never disagree about which fields count.
 */
const STATE_URL_FIELDS = [
    'autoProxyUrl',
    'autoHttpProxyUrl',
    'autoHttpsProxyUrl',
    'fallbackProxyUrl',
    'lastSystemProxyUrl',
    'manualProxyUrl'
] as const;

type StateUrlField = typeof STATE_URL_FIELDS[number];

export function proxyUrlsHaveCredentials(state: Pick<ProxyState, StateUrlField>): boolean {
    return STATE_URL_FIELDS.some(field => {
        const url = state[field];
        return Boolean(url && hasProxyCredentials(url));
    });
}

/**
 * The public URLs of the state's URL fields that carry credentials right now
 * (`getProxyPublicUrl` form — never userinfo), sorted and deduplicated.
 */
function liveCredentialBearingPublicUrls(state: Pick<ProxyState, StateUrlField>): string[] {
    const urls = new Set<string>();
    for (const field of STATE_URL_FIELDS) {
        const url = state[field];
        if (url && hasProxyCredentials(url)) {
            const publicUrl = getProxyPublicUrl(url);
            if (publicUrl) {
                urls.add(publicUrl);
            }
        }
    }
    return [...urls].sort();
}

/**
 * Sticky `authRequiredProxyUrls` derivation (#108): the union of the live
 * credential-bearing public URLs and the existing list, restricted to public
 * URLs that still appear in one of the state's URL fields. Returns undefined
 * when empty so a state persisted before the field existed stays byte-identical.
 */
export function deriveAuthRequiredProxyUrls(state: ProxyState): string[] | undefined {
    const present = new Set<string>();
    for (const field of STATE_URL_FIELDS) {
        const publicUrl = getProxyPublicUrl(state[field]);
        if (publicUrl) {
            present.add(publicUrl);
        }
    }

    const merged = new Set(liveCredentialBearingPublicUrls(state));
    for (const url of state.authRequiredProxyUrls ?? []) {
        if (present.has(url)) {
            merged.add(url);
        }
    }
    return merged.size > 0 ? [...merged].sort() : undefined;
}

export function deriveRequiresAuth(state: ProxyState): boolean {
    return proxyUrlsHaveCredentials(state) || state.requiresAuth === true;
}

export function setRequiresAuthFromLiveUrls(state: ProxyState): void {
    if (proxyUrlsHaveCredentials(state)) {
        state.requiresAuth = true;
        state.authRequiredProxyUrls = liveCredentialBearingPublicUrls(state);
        return;
    }
    delete state.requiresAuth;
    delete state.authRequiredProxyUrls;
}

/**
 * Skip when applying would write a proxy address without the credentials it
 * requires on this machine (#108): either the state says credentials are
 * required but no URL in the write plan carries one after hydration (the
 * pre-list rule, kept for states persisted before `authRequiredProxyUrls`
 * existed), or a plan URL without credentials names an address the state
 * recorded as credential-bearing. A per-scheme plan is skipped when ANY of
 * its addresses is missing its credentials; an address that never carried
 * credentials does not trip the gate.
 */
export function shouldSkipUnauthenticatedApply(
    state: ProxyState,
    activeUrl: string | readonly string[]
): boolean {
    const urls = (typeof activeUrl === 'string' ? [activeUrl] : activeUrl).filter(url => Boolean(url));
    if (urls.length === 0) {
        return false;
    }
    if (state.requiresAuth === true && !urls.some(url => hasProxyCredentials(url))) {
        return true;
    }
    const requiredUrls = state.authRequiredProxyUrls;
    if (!requiredUrls || requiredUrls.length === 0) {
        return false;
    }
    const required = new Set(requiredUrls);
    return urls.some(url => {
        if (hasProxyCredentials(url)) {
            return false;
        }
        const publicUrl = getProxyPublicUrl(url);
        return Boolean(publicUrl && required.has(publicUrl));
    });
}

export function sanitizeProxyStateForPersistence(state: ProxyState): ProxyState {
    const sanitized: ProxyState = { ...state };

    if ('manualProxyUrl' in state) {
        sanitized.manualProxyUrl = removeProxyCredentials(state.manualProxyUrl);
    }
    if ('autoProxyUrl' in state) {
        sanitized.autoProxyUrl = removeProxyCredentials(state.autoProxyUrl);
    }
    if ('autoHttpProxyUrl' in state) {
        sanitized.autoHttpProxyUrl = removeProxyCredentials(state.autoHttpProxyUrl);
    }
    if ('autoHttpsProxyUrl' in state) {
        sanitized.autoHttpsProxyUrl = removeProxyCredentials(state.autoHttpsProxyUrl);
    }
    if ('lastSystemProxyUrl' in state) {
        sanitized.lastSystemProxyUrl = removeProxyCredentials(state.lastSystemProxyUrl);
    }
    if ('fallbackProxyUrl' in state) {
        sanitized.fallbackProxyUrl = removeProxyCredentials(state.fallbackProxyUrl);
    }
    if ('lastError' in state) {
        sanitized.lastError = sanitizeOptionalMessage(state.lastError);
    }
    if ('lastTestResult' in state) {
        sanitized.lastTestResult = sanitizeProxyTestResultForPersistence(state.lastTestResult);
    }

    if (deriveRequiresAuth(state)) {
        sanitized.requiresAuth = true;
    } else {
        delete sanitized.requiresAuth;
    }

    const authRequiredProxyUrls = deriveAuthRequiredProxyUrls(state);
    if (authRequiredProxyUrls) {
        sanitized.authRequiredProxyUrls = authRequiredProxyUrls;
    } else {
        delete sanitized.authRequiredProxyUrls;
    }

    return sanitized;
}
