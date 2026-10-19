import { ErrorAggregator } from '../errors/ErrorAggregator';
import { UserNotifier } from '../errors/UserNotifier';
import { InputSanitizer } from '../validation/InputSanitizer';
import { proxyTargetLabel } from './ProxyTargetLabels';

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

/**
 * Off kept these values because their ownership could not be verified, so
 * "Proxy disabled" would be untrue. Names them by label, never by raw id.
 */
export function showProxyDisableUnverified(
    userNotifier: UserNotifier,
    targetIds: readonly string[]
): void {
    userNotifier.showWarning('warning.proxyOffUnverified', {
        targets: targetIds.map(proxyTargetLabel).join(', ')
    });
}
