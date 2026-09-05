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

import type { ProxyValueKind } from './v3Types';

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
    startedGeneration?: import('./LogicalGeneration').LogicalGeneration;
}

/**
 * Source that produced the currently applied Auto proxy URL.
 * Persisted so detection can tell its own VS Code `http.proxy` write apart
 * from a value that was already there (undefined = unknown provenance,
 * e.g. state saved by an older version — treated as "do not suppress").
 */
export type AppliedProxySource = 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | 'fallback';

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
 * @property {boolean} [pipConfigured] - Whether pip proxy is configured
 * @property {boolean} [terminalEnvConfigured] - Whether the terminal proxy environment is configured
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
    pipConfigured?: boolean;
    terminalEnvConfigured?: boolean;
    targetOutcomes?: Partial<Record<'git' | 'vscode' | 'npm' | 'pip' | 'terminalEnv',
        'configured' | 'cleared' | 'skippedUnavailable' | 'preservedExternal' | 'failed'>>;
    /**
     * Apply was refused before any target write. Distinct from a partial write
     * failure recorded only in lastError / targetOutcomes.
     */
    applyBlocked?: 'untrustedWorkspace' | 'invalidProxyUrl';
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
    lastDetectionSource?: AppliedProxySource; // Provenance of autoProxyUrl (issue #29 echo suppression)
    /**
     * Monotonic logical generation for this window's ProxyState.
     * Every committed write advances it so a completion derived from N cannot
     * mutate N+1 (issue #17 P1-3). Absent on states written before this field
     * existed; treat that as 0.
     */
    revision?: number;
    /**
     * True while a desired state has been saved but apply has not finished.
     * Receivers must not treat this as a converged success (issue #17 P1-6).
     */
    convergencePending?: boolean;
    /**
     * Last-applied HTTP bypass list (NO_PROXY / http.noProxy). Identity only;
     * used so a completion for a different bypass cannot land on the new one.
     */
    noProxy?: string;
    /**
     * Non-secret metadata: the active Auto/fallback endpoint requires credentials.
     * Persisted and synced so a receiver can refuse a credentialless apply.
     * Never contains userinfo.
     */
    requiresAuth?: boolean;
    autoProxyKind?: ProxyValueKind;
    autoHttpProxyUrl?: string;
    autoHttpsProxyUrl?: string;
    detectedBypass?: string;
    lastDetectionKind?: 'direct' | 'singleProxy' | 'perSchemeProxy' | 'pac' | 'wpad' | 'unknown';
    lastDetectionCapability?: 'supported' | 'unsupported' | 'readOnly' | 'parseUnavailable' | 'permissionRequired';
}

/**
 * Outcome of a revision-checked write. `superseded` means another owner
 * committed first; the caller must drop its snapshot instead of saving it.
 */
export type StateCommitResult =
    | { kind: 'committed'; revision: number; state: ProxyState }
    | { kind: 'superseded'; current: ProxyState };

export function stateRevision(state: ProxyState | undefined): number {
    const revision = state?.revision;
    return typeof revision === 'number' && Number.isFinite(revision) ? revision : 0;
}

export interface IProxyStateManager {
    getState(): Promise<ProxyState>;
    saveState(state: ProxyState): Promise<void>;
    /**
     * Writes `next` only when the stored revision is still `expectedRevision`.
     */
    commitState?(expectedRevision: number, next: ProxyState): Promise<StateCommitResult>;
    getActiveProxyUrl(state: ProxyState): string;
    getNextMode(currentMode: ProxyMode): ProxyMode;
}
