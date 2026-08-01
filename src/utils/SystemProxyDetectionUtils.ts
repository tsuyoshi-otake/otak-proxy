import { Logger } from './Logger';
import type { ProxyDetectionWithSource } from '../config/SystemProxyDetector';
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
    const result = await detectSystemProxySettingsWithSource();
    return result.proxyUrl;
}

/**
 * Detects system proxy settings, reporting which source produced the value.
 * The source is needed to persist provenance for echo suppression (issue #29).
 *
 * @returns The detected proxy URL with its source, or nulls if not found/invalid
 */
export async function detectSystemProxySettingsWithSource(): Promise<ProxyDetectionWithSource> {
    const detector = getSystemProxyDetector();
    const notifier = getUserNotifier();
    const urlValidator = getValidator();
    const urlSanitizer = getSanitizer();

    try {
        const detected = await detector.detectSystemProxyWithSource();

        if (!detected.proxyUrl) {
            Logger.log('No system proxy detected');
            return { proxyUrl: null, source: null };
        }

        const validationResult = urlValidator.validate(detected.proxyUrl);
        if (!validationResult.isValid) {
            Logger.warn('Detected system proxy has invalid format:', detected.proxyUrl);
            Logger.warn('Validation errors:', validationResult.errors.join(', '));

            notifier.showWarning(
                'warning.invalidFormat',
                { url: urlSanitizer.maskPassword(detected.proxyUrl) }
            );

            return { proxyUrl: null, source: null };
        }

        return detected;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('System proxy detection failed:', errorMsg);

        notifier.showWarning('warning.detectionFailed');

        return { proxyUrl: null, source: null };
    }
}
