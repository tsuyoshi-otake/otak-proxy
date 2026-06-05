import { TestResult } from '../utils/ProxyUtils';

export type ProxyCheckTrigger = 'polling' | 'focus' | 'config' | 'network';

/**
 * Configuration options for ProxyMonitor.
 */
export interface ProxyMonitorConfig {
    pollingInterval: number;
    debounceDelay: number;
    maxRetries: number;
    retryBackoffBase: number;
    detectionSourcePriority: string[];
    enableConnectionTest: boolean;
    connectionTestInterval: number;
}

/**
 * Result of a proxy detection operation.
 */
export interface ProxyDetectionResult {
    proxyUrl: string | null;
    source: 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;
    timestamp: number;
    success: boolean;
    error?: string;
    testResult?: TestResult;
    proxyReachable?: boolean;
}

/**
 * Interface for SystemProxyDetector to allow mocking.
 */
export interface ISystemProxyDetector {
    detectSystemProxy(): Promise<string | null>;
    detectSystemProxyWithSource?(): Promise<{ proxyUrl: string | null; source: string | null }>;
}
