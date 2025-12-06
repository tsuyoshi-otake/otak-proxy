/**
 * @file StatusBarManager
 * @description Manages the VSCode status bar item for proxy status display
 *
 * Requirements:
 * - 5.1: Initialize status bar after command registration
 * - 5.2: Reflect proxy state in status bar text and tooltip
 * - 5.3: Validate command links reference registered commands
 * - 5.4: Support internationalization for status bar text
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { Logger } from '../utils/Logger';

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
        'otak-proxy.importProxy'
    ];

    constructor(context: vscode.ExtensionContext) {
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
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
        const activeUrl = this.getActiveProxyUrl(state);
        let text = '';
        let statusText = '';

        // Get monitoring state and last check info
        const monitorState = this.monitorProvider?.getState() ?? null;
        const lastCheck = this.lastCheckProvider?.getLastCheck() ?? null;

        // Set text and status based on mode
        switch (state.mode) {
            case ProxyMode.Auto:
                if (activeUrl) {
                    text = `$(sync~spin) ${i18n.t('statusbar.autoWithUrl', { url: activeUrl })}`;
                    statusText = i18n.t('statusbar.tooltip.autoModeUsing', { url: activeUrl });
                } else {
                    text = `$(sync~spin) ${i18n.t('statusbar.autoNoProxy')}`;
                    statusText = i18n.t('statusbar.tooltip.autoModeNoProxy');
                }
                break;
            case ProxyMode.Manual:
                if (activeUrl) {
                    text = `$(plug) ${i18n.t('statusbar.manualWithUrl', { url: activeUrl })}`;
                    statusText = i18n.t('statusbar.tooltip.manualModeUsing', { url: activeUrl });
                } else {
                    text = `$(plug) ${i18n.t('statusbar.manualNotConfigured')}`;
                    statusText = i18n.t('statusbar.tooltip.manualModeNotConfigured');
                }
                break;
            case ProxyMode.Off:
            default:
                text = `$(circle-slash) ${i18n.t('statusbar.proxyOff')}`;
                statusText = i18n.t('statusbar.tooltip.proxyDisabled');
                break;
        }

        this.statusBarItem.text = text;

        // Build tooltip
        const tooltip = this.buildTooltip(state, statusText, monitorState, lastCheck, i18n);
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
    }

    /**
     * Build markdown tooltip
     */
    private buildTooltip(
        state: ProxyState,
        statusText: string,
        monitorState: MonitorState | null,
        lastCheck: LastCheckInfo | null,
        i18n: I18nManager
    ): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = true;
        tooltip.supportThemeIcons = true;

        // Header
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.title')}**\n\n`);
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.currentMode')}:** ${state.mode.toUpperCase()}\n\n`);
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.status')}:** ${statusText}\n\n`);

        // Auto mode specific information
        if (state.mode === ProxyMode.Auto && lastCheck) {
            const lastCheckTime = new Date(lastCheck.timestamp).toLocaleTimeString();
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.lastCheck')}:** ${lastCheckTime}\n\n`);

            if (lastCheck.source) {
                tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.detectionSource')}:** ${lastCheck.source}\n\n`);
            }

            if (!lastCheck.success && lastCheck.error) {
                tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.lastError')}:** $(warning) ${lastCheck.error}\n\n`);
            }
        }

        // Monitoring state for Auto mode
        if (state.mode === ProxyMode.Auto && monitorState) {
            if (monitorState.consecutiveFailures > 0) {
                tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.consecutiveFailures')}:** $(warning) ${monitorState.consecutiveFailures}\n\n`);
            }
        }

        // Proxy URLs
        if (state.manualProxyUrl) {
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.manualProxy')}:** ${this.sanitizer.maskPassword(state.manualProxyUrl)}\n\n`);
        }
        if (state.autoProxyUrl) {
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.systemProxy')}:** ${this.sanitizer.maskPassword(state.autoProxyUrl)}\n\n`);
        }

        tooltip.appendMarkdown(`---\n\n`);

        // Command links
        this.appendCommandLinks(tooltip, i18n);

        return tooltip;
    }

    /**
     * Append command links to tooltip
     *
     * Requirement 5.3: Validate command links
     */
    private appendCommandLinks(tooltip: vscode.MarkdownString, i18n: I18nManager): void {
        const commandLinks = [
            { icon: '$(sync)', label: i18n.t('statusbar.link.toggleMode'), command: 'otak-proxy.toggleProxy' },
            { icon: '$(gear)', label: i18n.t('statusbar.link.configureManual'), command: 'otak-proxy.configureUrl' },
            { icon: '$(cloud-download)', label: i18n.t('statusbar.link.importSystem'), command: 'otak-proxy.importProxy' },
            { icon: '$(debug-start)', label: i18n.t('statusbar.link.testProxy'), command: 'otak-proxy.testProxy' }
        ];

        // Validate command links
        for (const link of commandLinks) {
            if (!this.registeredCommands.includes(link.command)) {
                Logger.warn(`Command link references unregistered command: ${link.command}`);
            }
        }

        // Build command links markdown
        const linkMarkdown = commandLinks
            .map(link => `${link.icon} [${link.label}](command:${link.command})`)
            .join(' &nbsp;&nbsp; ');
        tooltip.appendMarkdown(linkMarkdown);
    }

    /**
     * Get active proxy URL based on mode
     */
    private getActiveProxyUrl(state: ProxyState): string {
        switch (state.mode) {
            case ProxyMode.Auto:
                return state.autoProxyUrl || '';
            case ProxyMode.Manual:
                return state.manualProxyUrl || '';
            default:
                return '';
        }
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
