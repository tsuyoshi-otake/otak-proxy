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

export function proxyUrlsHaveCredentials(state: Pick<ProxyState,
    'autoProxyUrl' | 'autoHttpProxyUrl' | 'autoHttpsProxyUrl' |
    'fallbackProxyUrl' | 'lastSystemProxyUrl' | 'manualProxyUrl'
>): boolean {
    return [
        state.autoProxyUrl,
        state.autoHttpProxyUrl,
        state.autoHttpsProxyUrl,
        state.fallbackProxyUrl,
        state.lastSystemProxyUrl,
        state.manualProxyUrl
    ].some(url => Boolean(url && hasProxyCredentials(url)));
}

export function deriveRequiresAuth(state: ProxyState): boolean {
    return proxyUrlsHaveCredentials(state) || state.requiresAuth === true;
}

export function setRequiresAuthFromLiveUrls(state: ProxyState): void {
    if (proxyUrlsHaveCredentials(state)) {
        state.requiresAuth = true;
        return;
    }
    delete state.requiresAuth;
}

/**
 * Skip when the state says credentials are required but no URL in the write
 * plan carries one after hydration — applying would overwrite the target with
 * credential-less URLs. A single URL is exactly the pre-#108 rule; a
 * per-scheme plan is skipped only when none of its URLs is credentialed.
 */
export function shouldSkipUnauthenticatedApply(
    state: ProxyState,
    activeUrl: string | readonly string[]
): boolean {
    const urls = (typeof activeUrl === 'string' ? [activeUrl] : activeUrl).filter(url => Boolean(url));
    return urls.length > 0 && state.requiresAuth === true && !urls.some(url => hasProxyCredentials(url));
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

    return sanitized;
}
