/**
 * @file Core Type Definitions
 * @description Centralized type definitions for the otak-proxy extension
 *
 * This module contains all shared types, enums, and interfaces used across
 * the extension. Extracting these to a dedicated module improves:
 * - Code organization and maintainability (Requirement 1.1)
 * - File size constraints (Requirement 1.2)
 * - Clear folder hierarchy (Requirement 1.5)
 */

import * as vscode from 'vscode';

/**
 * Proxy operation modes
 *
 * @enum {string}
 * @property {string} Off - Proxy is disabled
 * @property {string} Manual - Manual proxy URL is used
 * @property {string} Auto - System proxy is automatically detected and used
 */
export enum ProxyMode {
    Off = 'off',
    Manual = 'manual',
    Auto = 'auto'
}

/**
 * Connection test result interface
 * Feature: auto-mode-proxy-testing
 * @interface ProxyTestResult
 */
export interface ProxyTestResult {
    success: boolean;
    testUrls: string[];
    errors: Array<{ url: string; message: string }>;
    proxyUrl?: string;
    timestamp?: number;
    duration?: number;
}

/**
 * Proxy state interface representing the current proxy configuration
 *
 * @interface ProxyState
 * @property {ProxyMode} mode - Current proxy mode
 * @property {string} [manualProxyUrl] - Manually configured proxy URL
 * @property {string} [autoProxyUrl] - Automatically detected system proxy URL
 * @property {number} [lastSystemProxyCheck] - Timestamp of last system proxy check
 * @property {boolean} [gitConfigured] - Whether Git proxy is configured
 * @property {boolean} [vscodeConfigured] - Whether VSCode proxy is configured
 * @property {boolean} [npmConfigured] - Whether npm proxy is configured
 * @property {boolean} [systemProxyDetected] - Whether system proxy was detected
 * @property {string} [lastError] - Last error message if any
 * @property {ProxyTestResult} [lastTestResult] - Last connection test result (Feature: auto-mode-proxy-testing)
 * @property {boolean} [proxyReachable] - Whether the proxy is currently reachable (Feature: auto-mode-proxy-testing)
 * @property {number} [lastTestTimestamp] - Timestamp of last connection test (Feature: auto-mode-proxy-testing)
 * @property {boolean} [usingFallbackProxy] - Whether currently using fallback proxy (Feature: auto-mode-fallback-improvements)
 * @property {boolean} [autoModeOff] - Whether Auto mode is temporarily OFF (Feature: auto-mode-fallback-improvements)
 * @property {string} [lastSystemProxyUrl] - Last detected system proxy URL (Feature: auto-mode-fallback-improvements)
 * @property {string} [fallbackProxyUrl] - Currently used fallback proxy URL (Feature: auto-mode-fallback-improvements)
 */
export interface ProxyState {
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    lastSystemProxyCheck?: number;
    gitConfigured?: boolean;
    vscodeConfigured?: boolean;
    npmConfigured?: boolean;
    systemProxyDetected?: boolean;
    lastError?: string;
    // Feature: auto-mode-proxy-testing
    lastTestResult?: ProxyTestResult;
    proxyReachable?: boolean;
    lastTestTimestamp?: number;
    // Feature: auto-mode-fallback-improvements
    usingFallbackProxy?: boolean;        // Whether currently using fallback proxy
    autoModeOff?: boolean;               // Auto Mode OFF state (waiting for proxy)
    lastSystemProxyUrl?: string;         // Last detected system proxy URL
    fallbackProxyUrl?: string;           // Currently used fallback proxy URL
}

// Forward declarations for manager types to avoid circular dependencies
// These will be properly typed when the respective modules are created
export interface IProxyStateManager {
    getState(): Promise<ProxyState>;
    saveState(state: ProxyState): Promise<void>;
    getActiveProxyUrl(state: ProxyState): string;
    getNextMode(currentMode: ProxyMode): ProxyMode;
}

export interface IProxyApplier {
    applyProxy(proxyUrl: string, enabled: boolean): Promise<boolean>;
    disableProxy(): Promise<boolean>;
}

export interface IStatusBarManager {
    update(state: ProxyState): void;
}

/**
 * Command execution context providing access to all required components
 *
 * @interface CommandContext
 * @property {vscode.ExtensionContext} extensionContext - VSCode extension context
 * @property {IProxyStateManager} stateManager - Proxy state manager instance
 * @property {IProxyApplier} proxyApplier - Proxy applier instance
 * @property {IStatusBarManager} statusBarManager - Status bar manager instance
 */
export interface CommandContext {
    extensionContext: vscode.ExtensionContext;
    stateManager: IProxyStateManager;
    proxyApplier: IProxyApplier;
    statusBarManager: IStatusBarManager;
}
