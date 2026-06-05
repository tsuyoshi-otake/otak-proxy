/**
 * @file Proxy Utility Functions
 * @description Compatibility entrypoint for proxy URL validation, sanitization, testing, and detection.
 */

export { detectSystemProxySettings } from './SystemProxyDetectionUtils';
export {
    getDefaultAutoTimeout,
    getDefaultManualTimeout,
    getDefaultTestUrls,
    testProxyConnection,
    testProxyConnectionParallel
} from './ProxyConnectionTest';
export { resetInstances, updateDetectionPriority } from './ProxyUtilityInstances';
export { sanitizeProxyUrl, validateProxyUrl } from './ProxyUrlUtils';
export { TestOptions, TestResult, TestUrlError } from './ProxyTestTypes';
