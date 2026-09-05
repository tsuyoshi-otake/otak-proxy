/**
 * @file Proxy Utility Functions
 * @description Compatibility entrypoint for proxy URL validation, sanitization, testing, and detection.
 */

export { detectSystemProxySettings, detectSystemProxySettingsWithSource } from './SystemProxyDetectionUtils';
export {
    getDefaultAutoTimeout,
    getDefaultManualTimeout,
    getDefaultTestUrls,
    testProxyConnection,
    testProxyConnectionParallel
} from './ProxyConnectionTest';
export { resetInstances } from './ProxyUtilityInstances';
export { sanitizeProxyUrl, validateProxyUrl } from './ProxyUrlUtils';
export type { ProxyTestFailureKind, TestResult, TestUrlError } from './ProxyTestTypes';
export {
    buildConnectionTestObservation,
    isProxyEndpointReachable,
    isProxyEndpointUnreachable
} from './ProxyTestFailure';
