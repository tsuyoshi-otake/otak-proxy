import * as vscode from 'vscode';
import { UserNotifier } from '../errors/UserNotifier';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';

let validator: ProxyUrlValidator | null = null;
let sanitizer: InputSanitizer | null = null;
let systemProxyDetector: SystemProxyDetector | null = null;
let systemProxyDetectorPriorityKey: string | null = null;
let userNotifier: UserNotifier | null = null;

/**
 * Get or create the ProxyUrlValidator instance.
 */
export function getValidator(): ProxyUrlValidator {
    if (!validator) {
        validator = new ProxyUrlValidator();
    }
    return validator;
}

/**
 * Get or create the InputSanitizer instance.
 */
export function getSanitizer(): InputSanitizer {
    if (!sanitizer) {
        sanitizer = new InputSanitizer();
    }
    return sanitizer;
}

/**
 * Get or create the SystemProxyDetector instance.
 */
export function getSystemProxyDetector(): SystemProxyDetector {
    const config = vscode.workspace.getConfiguration('otakProxy');
    const detectionSourcePriority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
    const priorityKey = JSON.stringify(detectionSourcePriority);

    if (!systemProxyDetector) {
        systemProxyDetector = new SystemProxyDetector(detectionSourcePriority);
        systemProxyDetectorPriorityKey = priorityKey;
    } else if (systemProxyDetectorPriorityKey !== priorityKey) {
        systemProxyDetector.updateDetectionPriority(detectionSourcePriority);
        systemProxyDetectorPriorityKey = priorityKey;
    }
    return systemProxyDetector;
}

/**
 * Get or create the UserNotifier instance.
 */
export function getUserNotifier(): UserNotifier {
    if (!userNotifier) {
        userNotifier = new UserNotifier();
    }
    return userNotifier;
}

/**
 * Updates the detection priority for system proxy detection.
 *
 * @param priority - Array of detection sources in priority order
 */
export function updateDetectionPriority(priority: string[]): void {
    const detector = getSystemProxyDetector();
    detector.updateDetectionPriority(priority);
    systemProxyDetectorPriorityKey = JSON.stringify(priority);
}

/**
 * Resets module-level instances.
 */
export function resetInstances(): void {
    validator = null;
    sanitizer = null;
    systemProxyDetector = null;
    systemProxyDetectorPriorityKey = null;
    userNotifier = null;
}
