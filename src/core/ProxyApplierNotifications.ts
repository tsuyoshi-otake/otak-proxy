import { ErrorAggregator } from '../errors/ErrorAggregator';
import { UserNotifier } from '../errors/UserNotifier';
import { InputSanitizer } from '../validation/InputSanitizer';

export function showAggregatedErrors(
    errorAggregator: ErrorAggregator,
    userNotifier: UserNotifier
): void {
    const { message, suggestions } = errorAggregator.getDisplayParts();
    userNotifier.showError(message, suggestions);
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
