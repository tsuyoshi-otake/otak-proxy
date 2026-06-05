import { I18nManager } from '../i18n/I18nManager';

function translateProxyValidationError(error: string): string {
    const i18n = I18nManager.getInstance();
    const keyByMessage: Record<string, string> = {
        'Proxy URL cannot be empty': 'validation.proxyUrl.empty',
        'Proxy URL contains dangerous shell metacharacters': 'validation.proxyUrl.shellMetacharacters',
        'Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)': 'validation.proxyUrl.hostnameInvalid',
        'Invalid URL format': 'validation.proxyUrl.invalidFormat',
        'Protocol must be http:// or https://': 'validation.proxyUrl.protocol',
        'Hostname is required': 'validation.proxyUrl.hostnameRequired',
        'Port must be between 1 and 65535': 'validation.proxyUrl.portRange',
        'Username contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)': 'validation.proxyUrl.usernameInvalid',
        'Password contains invalid characters (only alphanumeric, hyphens, underscores, and @ allowed)': 'validation.proxyUrl.passwordInvalid'
    };

    const key = keyByMessage[error];
    return key ? i18n.t(key) : error;
}

export function buildProxyValidationSuggestions(errors: string[]): string[] {
    return [
        ...errors.map(translateProxyValidationError),
        'suggestion.useFormat',
        'suggestion.includeProtocol',
        'suggestion.validHostname'
    ];
}
