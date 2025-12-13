/**
 * @file SyncStatusProvider
 * @description Provides sync status display in VSCode StatusBar
 *
 * Feature: multi-instance-sync
 * Requirements: 6.1, 6.2, 6.3, 6.4
 *
 * Provides:
 * - Sync icon display when multiple instances detected (6.1)
 * - Visual indicator during sync (6.2)
 * - Warning display on sync errors (6.3)
 * - Detailed status on click (6.4)
 */

import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { SyncStatus } from './SyncManager';

/**
 * Display state for sync status
 */
export interface SyncDisplayState {
    /** Icon to display */
    icon: string;
    /** Tooltip text */
    tooltip: string;
    /** Whether sync indicator should be visible */
    visible: boolean;
    /** Background color (if warning/error) */
    backgroundColor?: vscode.ThemeColor;
}

/**
 * Interface for SyncStatusProvider
 */
export interface ISyncStatusProvider {
    /**
     * Update the display with current sync status
     */
    update(status: SyncStatus): void;

    /**
     * Show the sync status indicator
     */
    show(): void;

    /**
     * Hide the sync status indicator
     */
    hide(): void;

    /**
     * Dispose of resources
     */
    dispose(): void;
}

/**
 * Icons for different sync states
 */
const SYNC_ICONS = {
    /** Normal sync icon */
    synced: '$(sync)',
    /** Syncing in progress */
    syncing: '$(sync~spin)',
    /** Sync error */
    error: '$(sync-ignored)',
    /** Standalone mode (no sync) */
    standalone: '$(debug-disconnect)'
};

/**
 * SyncStatusProvider manages the sync status display in the VSCode status bar.
 *
 * Features:
 * - Shows sync icon when multiple instances are connected
 * - Animates during sync operations
 * - Shows warning on sync errors
 * - Displays detailed tooltip with connection info
 */
export class SyncStatusProvider implements ISyncStatusProvider {
    private statusBarItem: vscode.StatusBarItem;
    private i18n: I18nManager;
    private currentStatus: SyncStatus | null = null;

    /**
     * Create a new SyncStatusProvider
     *
     * @param priority Status bar item priority
     */
    constructor(priority: number = 99) {
        this.i18n = I18nManager.getInstance();

        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            priority
        );

        // Set up click command
        this.statusBarItem.command = 'otak-proxy.showSyncStatus';
    }

    /**
     * Update the display with current sync status
     *
     * @param status Current sync status
     */
    update(status: SyncStatus): void {
        this.currentStatus = status;
        const displayState = this.calculateDisplayState(status);

        // Update status bar item
        this.statusBarItem.text = displayState.icon;
        this.statusBarItem.tooltip = this.buildTooltip(status, displayState);

        if (displayState.backgroundColor) {
            this.statusBarItem.backgroundColor = displayState.backgroundColor;
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }

        // Show/hide based on visibility
        if (displayState.visible) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    /**
     * Show the sync status indicator
     */
    show(): void {
        this.statusBarItem.show();
    }

    /**
     * Hide the sync status indicator
     */
    hide(): void {
        this.statusBarItem.hide();
    }

    /**
     * Get the current display state
     */
    getDisplayState(): SyncDisplayState | null {
        if (!this.currentStatus) {
            return null;
        }
        return this.calculateDisplayState(this.currentStatus);
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.statusBarItem.dispose();
    }

    /**
     * Calculate display state based on sync status
     */
    private calculateDisplayState(status: SyncStatus): SyncDisplayState {
        // Not enabled - standalone mode
        if (!status.enabled) {
            return {
                icon: SYNC_ICONS.standalone,
                tooltip: this.i18n.t('sync.standalone'),
                visible: false // Don't show when standalone
            };
        }

        // Syncing in progress
        if (status.isSyncing) {
            return {
                icon: SYNC_ICONS.syncing,
                tooltip: this.i18n.t('sync.status.syncing'),
                visible: true
            };
        }

        // Error state
        if (status.lastError) {
            return {
                icon: SYNC_ICONS.error,
                tooltip: this.i18n.t('sync.tooltip.error', { error: status.lastError }),
                visible: true,
                backgroundColor: new vscode.ThemeColor('statusBarItem.warningBackground')
            };
        }

        // Multiple instances - show sync indicator
        if (status.activeInstances > 1) {
            return {
                icon: SYNC_ICONS.synced,
                tooltip: this.i18n.t('sync.tooltip.connected', {
                    count: String(status.activeInstances)
                }),
                visible: true
            };
        }

        // Single instance - hide sync indicator
        return {
            icon: SYNC_ICONS.synced,
            tooltip: this.i18n.t('sync.enabled'),
            visible: false // Only show when multiple instances
        };
    }

    /**
     * Build detailed tooltip content
     */
    private buildTooltip(status: SyncStatus, displayState: SyncDisplayState): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString();
        tooltip.isTrusted = true;

        // Header
        tooltip.appendMarkdown(`### $(sync) ${this.i18n.t('sync.enabled')}\n\n`);

        // Status
        if (status.isSyncing) {
            tooltip.appendMarkdown(`$(loading~spin) ${this.i18n.t('sync.status.syncing')}\n\n`);
        } else if (status.lastError) {
            tooltip.appendMarkdown(`$(warning) ${this.i18n.t('sync.status.error')}: ${status.lastError}\n\n`);
        } else {
            tooltip.appendMarkdown(`$(check) ${this.i18n.t('sync.status.synced')}\n\n`);
        }

        // Instance count
        if (status.activeInstances > 0) {
            tooltip.appendMarkdown(`$(vm) ${this.i18n.t('sync.instances', {
                count: String(status.activeInstances)
            })}\n\n`);
        }

        // Last sync time
        if (status.lastSyncTime) {
            const lastSyncDate = new Date(status.lastSyncTime);
            const timeStr = lastSyncDate.toLocaleTimeString();
            tooltip.appendMarkdown(`$(clock) ${this.i18n.t('sync.tooltip.lastSync', { time: timeStr })}\n\n`);
        }

        // Click action hint
        tooltip.appendMarkdown(`---\n\n`);
        tooltip.appendMarkdown(`$(info) Click for more details`);

        return tooltip;
    }

    /**
     * Show detailed sync status in an information message
     */
    async showDetailedStatus(): Promise<void> {
        if (!this.currentStatus) {
            vscode.window.showInformationMessage(this.i18n.t('sync.disabled'));
            return;
        }

        const status = this.currentStatus;
        let message: string;

        if (!status.enabled) {
            message = this.i18n.t('sync.standalone');
        } else if (status.lastError) {
            message = `${this.i18n.t('sync.status.error')}: ${status.lastError}`;
        } else if (status.activeInstances > 1) {
            message = this.i18n.t('sync.instances', { count: String(status.activeInstances) });
        } else {
            message = this.i18n.t('sync.enabled');
        }

        await vscode.window.showInformationMessage(message);
    }

    /**
     * Show conflict resolution notification
     */
    showConflictResolved(): void {
        vscode.window.showInformationMessage(
            this.i18n.t('sync.notification.conflictResolved')
        );
    }
}

/**
 * Register the showSyncStatus command
 */
export function registerSyncStatusCommand(
    context: vscode.ExtensionContext,
    statusProvider: SyncStatusProvider
): void {
    const command = vscode.commands.registerCommand(
        'otak-proxy.showSyncStatus',
        () => statusProvider.showDetailedStatus()
    );

    context.subscriptions.push(command);
}
