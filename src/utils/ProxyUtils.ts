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
export { canonicalizeValidProxyUrl, sanitizeProxyUrl, tryCanonicalizeProxyUrl, validateProxyUrl } from './ProxyUrlUtils';
export type { ProxyTestFailureKind, TestResult, TestUrlError } from './ProxyTestTypes';
export type { ProxyEndpointVerdict } from './ProxyTestFailure';
export {
    buildConnectionTestObservation,
    isProxyEndpointReachable,
    isProxyEndpointUnreachable,
    proxyEndpointVerdict
} from './ProxyTestFailure';
