import { ProxyState, ProxyTestResult } from '../core/types';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';

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

    try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return removeProxyCredentials(url);
    }
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

    return sanitized;
}

export function sanitizeProxyStateForPersistence(state: ProxyState): ProxyState {
    const sanitized: ProxyState = { ...state };

    if ('manualProxyUrl' in state) {
        sanitized.manualProxyUrl = removeProxyCredentials(state.manualProxyUrl);
    }
    if ('autoProxyUrl' in state) {
        sanitized.autoProxyUrl = removeProxyCredentials(state.autoProxyUrl);
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

    return sanitized;
}
