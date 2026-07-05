/**
 * @file StatusBarManager
 * @description Manages the VSCode status bar item for proxy status display
 *
 * Requirements:
 * - 5.1: Initialize status bar after command registration
 * - 5.2: Reflect proxy state in status bar text and tooltip
 * - 5.3: Validate command links reference registered commands
 * - 5.4: Support internationalization for status bar text
 *
 * Feature: auto-mode-fallback-improvements
 * - Task 4.1: Update for fallback status display
 * - Task 4.4: Tooltip updates for Auto Mode OFF and OFF mode
 */

import * as vscode from 'vscode';
import { ProxyState } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { getStatusBarDisplay } from './StatusBarDisplay';
import { buildStatusBarTooltip } from './StatusBarTooltip';

/**
 * Interface for monitoring state used in tooltip
 * Matches MonitoringStatus from ProxyMonitorState
 */
export interface MonitorState {
    isActive: boolean;
    lastCheckTime: number | null;
    lastSuccessTime: number | null;
    lastFailureTime: number | null;
    consecutiveFailures: number;
    currentProxy: string | null;
    detectionSource: string | null;
}

/**
 * Interface for last check information used in tooltip
 * Matches ProxyCheckEvent from ProxyChangeLogger
 */
export interface LastCheckInfo {
    timestamp: number;
    source: string | null;
    success: boolean;
    error?: string | null;
}

/**
 * Interface for monitor providers (ProxyMonitor and ProxyChangeLogger)
 */
export interface IMonitorProvider {
    getState(): MonitorState | null;
}

export interface ILastCheckProvider {
    getLastCheck(): LastCheckInfo | null;
}

/**
 * StatusBarManager handles all status bar operations
 *
 * Requirement 5.2: Status bar state reflection
 * Requirement 5.3: Command link validation
 * Requirement 5.4: Internationalization support
 */
export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private sanitizer: InputSanitizer;
    private monitorProvider: IMonitorProvider | null = null;
    private lastCheckProvider: ILastCheckProvider | null = null;

    /**
     * Registered commands for validation
     * Requirement 5.3: Command link validation
     */
    private readonly registeredCommands = [
        'otak-proxy.toggleProxy',
        'otak-proxy.configureUrl',
        'otak-proxy.testProxy',
        'otak-proxy.importProxy',
        'otak-proxy.toggleShowProxyUrl'
    ];

    constructor(context: vscode.ExtensionContext) {
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'otak-proxy.toggleProxy';
        context.subscriptions.push(this.statusBarItem);

        // Initialize sanitizer for password masking
        this.sanitizer = new InputSanitizer();
    }

    /**
     * Set monitor providers for extended tooltip information
     */
    setMonitorProviders(
        monitorProvider: IMonitorProvider | null,
        lastCheckProvider: ILastCheckProvider | null
    ): void {
        this.monitorProvider = monitorProvider;
        this.lastCheckProvider = lastCheckProvider;
    }

    /**
     * Update status bar based on proxy state
     *
     * Requirement 5.2: Reflect proxy state in status bar
     * Requirement 5.4: Use translated strings
     */
    update(state: ProxyState): void {
        const i18n = I18nManager.getInstance();
        const config = vscode.workspace.getConfiguration('otakProxy');
        const showUrl = config.get<boolean>('showProxyUrl', true);
        const showTooltip = config.get<boolean>('statusBarTooltip', true);

        // Get monitoring state and last check info
        const monitorState = this.monitorProvider?.getState() ?? null;
        const lastCheck = this.lastCheckProvider?.getLastCheck() ?? null;
        const display = getStatusBarDisplay(state, showUrl, i18n, this.sanitizer);

        this.statusBarItem.text = display.text;

        this.statusBarItem.tooltip = showTooltip
            ? buildStatusBarTooltip({
                state,
                statusText: display.statusText,
                monitorState,
                lastCheck,
                i18n,
                sanitizer: this.sanitizer,
                registeredCommands: this.registeredCommands,
                showUrl
            })
            : undefined;
        this.statusBarItem.show();
    }

    /**
     * Dispose of status bar item
     */
    dispose(): void {
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
        }
    }

    /**
     * Get the underlying status bar item (for backward compatibility)
     */
    getStatusBarItem(): vscode.StatusBarItem {
        return this.statusBarItem;
    }
}
