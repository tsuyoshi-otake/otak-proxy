import { ErrorAggregator } from '../errors/ErrorAggregator';
import { UserNotifier } from '../errors/UserNotifier';
import { InputSanitizer } from '../validation/InputSanitizer';

export function showAggregatedErrors(
    errorAggregator: ErrorAggregator,
    userNotifier: UserNotifier
): void {
    const formattedErrors = errorAggregator.formatErrors();
    const lines = formattedErrors.split('\n');
    const suggestionStartIndex = lines.findIndex(line => line.includes('Suggestions:'));
    const suggestions = suggestionStartIndex >= 0
        ? lines
            .slice(suggestionStartIndex + 1)
            .filter(line => line.trim().startsWith('-'))
            .map(line => line.trim().substring(2))
        : [];

    const errorMessage = lines
        .slice(0, suggestionStartIndex >= 0 ? suggestionStartIndex : lines.length)
        .join('\n');
    userNotifier.showError(errorMessage, suggestions);
}

export function showProxyConfigured(
    proxyUrl: string,
    sanitizer: InputSanitizer,
    userNotifier: UserNotifier
): void {
    const sanitizedUrl = sanitizer.maskPassword(proxyUrl);
    userNotifier.showSuccess('message.proxyConfigured', { url: sanitizedUrl });
}

export function showProxyDisabled(userNotifier: UserNotifier): void {
    userNotifier.showSuccess('message.proxyDisabled');
}
