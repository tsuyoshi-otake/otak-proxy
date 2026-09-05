import { TestResult } from '../utils/ProxyUtils';
import type { ProxyCapability, ProxyValueKind } from '../core/v3Types';
import type { ProxyDetectionWithSource } from '../config/SystemProxyDetector';

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
    kind?: ProxyValueKind;
    capability?: ProxyCapability;
    timestamp: number;
    success: boolean;
    error?: string;
    testResult?: TestResult;
    proxyReachable?: boolean;
    startedGeneration?: import('../core/LogicalGeneration').LogicalGeneration;
}

/**
 * Interface for SystemProxyDetector to allow mocking.
 */
export interface ISystemProxyDetector {
    detectSystemProxy(): Promise<string | null>;
    detectSystemProxyWithSource?(): Promise<ProxyDetectionWithSource>;
}
