import { Logger } from './Logger';
import {
    getSanitizer,
    getSystemProxyDetector,
    getUserNotifier,
    getValidator
} from './ProxyUtilityInstances';

/**
 * Detects system proxy settings.
 *
 * @returns The detected proxy URL or null if not found/invalid
 */
export async function detectSystemProxySettings(): Promise<string | null> {
    const detector = getSystemProxyDetector();
    const notifier = getUserNotifier();
    const urlValidator = getValidator();
    const urlSanitizer = getSanitizer();

    try {
        const detectedProxy = await detector.detectSystemProxy();

        if (!detectedProxy) {
            Logger.log('No system proxy detected');
            return null;
        }

        const validationResult = urlValidator.validate(detectedProxy);
        if (!validationResult.isValid) {
            Logger.warn('Detected system proxy has invalid format:', detectedProxy);
            Logger.warn('Validation errors:', validationResult.errors.join(', '));

            notifier.showWarning(
                'warning.invalidFormat',
                { url: urlSanitizer.maskPassword(detectedProxy) }
            );

            return null;
        }

        return detectedProxy;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('System proxy detection failed:', errorMsg);

        notifier.showWarning('warning.detectionFailed');

        return null;
    }
}
