import { ProxyMode, ProxyState } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';

export interface StatusBarDisplay {
    text: string;
    statusText: string;
}

export function getStatusBarDisplay(
    state: ProxyState,
    showUrl: boolean,
    i18n: I18nManager,
    sanitizer: InputSanitizer
): StatusBarDisplay {
    const activeUrl = getActiveProxyUrl(state);

    switch (state.mode) {
        case ProxyMode.Auto:
            return getAutoDisplay(state, activeUrl, showUrl, i18n, sanitizer);
        case ProxyMode.Manual:
            return getManualDisplay(activeUrl, showUrl, i18n, sanitizer);
        case ProxyMode.Off:
        default:
            return {
                text: `$(circle-slash) ${i18n.t('statusbar.proxyOff')}`,
                statusText: i18n.t('statusbar.tooltip.proxyDisabled')
            };
    }
}

export function getUrlDisplay(
    url: string,
    showUrl: boolean,
    i18n: I18nManager,
    sanitizer: InputSanitizer
): string {
    return showUrl ? sanitizer.maskPassword(url) : i18n.t('statusbar.urlHidden');
}

function getAutoDisplay(
    state: ProxyState,
    activeUrl: string,
    showUrl: boolean,
    i18n: I18nManager,
    sanitizer: InputSanitizer
): StatusBarDisplay {
    if (state.autoModeOff) {
        return {
            text: `$(circle-slash) ${i18n.t('statusbar.autoOff')}`,
            statusText: i18n.t('statusbar.tooltip.autoOff')
        };
    }

    if (state.usingFallbackProxy && state.fallbackProxyUrl) {
        const fallbackDisplay = getUrlDisplay(state.fallbackProxyUrl, showUrl, i18n, sanitizer);
        return {
            text: `$(plug) ${i18n.t('statusbar.autoFallback', { url: fallbackDisplay })}`,
            statusText: i18n.t('statusbar.tooltip.autoFallback', { url: fallbackDisplay })
        };
    }

    if (activeUrl) {
        const urlDisplay = getUrlDisplay(activeUrl, showUrl, i18n, sanitizer);
        return {
            text: `$(sync~spin) ${i18n.t('statusbar.autoWithUrl', { url: urlDisplay })}`,
            statusText: i18n.t('statusbar.tooltip.autoModeUsing', { url: urlDisplay })
        };
    }

    return {
        text: `$(sync~spin) ${i18n.t('statusbar.autoNoProxy')}`,
        statusText: i18n.t('statusbar.tooltip.autoModeNoProxy')
    };
}

function getManualDisplay(
    activeUrl: string,
    showUrl: boolean,
    i18n: I18nManager,
    sanitizer: InputSanitizer
): StatusBarDisplay {
    if (!activeUrl) {
        return {
            text: `$(plug) ${i18n.t('statusbar.manualNotConfigured')}`,
            statusText: i18n.t('statusbar.tooltip.manualModeNotConfigured')
        };
    }

    const urlDisplay = getUrlDisplay(activeUrl, showUrl, i18n, sanitizer);
    return {
        text: `$(plug) ${i18n.t('statusbar.manualWithUrl', { url: urlDisplay })}`,
        statusText: i18n.t('statusbar.tooltip.manualModeUsing', { url: urlDisplay })
    };
}

function getActiveProxyUrl(state: ProxyState): string {
    switch (state.mode) {
        case ProxyMode.Auto:
            return state.autoProxyUrl || '';
        case ProxyMode.Manual:
            return state.manualProxyUrl || '';
        default:
            return '';
    }
}
