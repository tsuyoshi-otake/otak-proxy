/**
 * @file ProxyStateManager
 * @description Manages proxy state persistence and retrieval
 *
 * This module centralizes all state management logic, including:
 * - Reading and writing proxy state to global storage
 * - In-memory fallback when storage fails (Requirement 3.2)
 * - Migration from legacy settings (Requirement 3.3)
 * - State validation and helper methods
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState, IProxyStateManager } from './types';
import { Logger } from '../utils/Logger';
import { I18nManager } from '../i18n/I18nManager';

/**
 * ProxyStateManager handles all proxy state operations
 *
 * Requirement 3.1: Centralized state management
 * Requirement 3.2: Automatic in-memory fallback on storage failure
 * Requirement 3.3: Transparent migration from legacy settings
 */
export class ProxyStateManager implements IProxyStateManager {
    private inMemoryState: ProxyState | null = null;

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Get the current proxy state
     *
     * Requirement 3.2: Returns in-memory fallback if available
     * Requirement 3.3: Migrates from old settings if needed
     *
     * @returns {Promise<ProxyState>} Current proxy state
     */
    async getState(): Promise<ProxyState> {
        // If we have an in-memory fallback state, use it
        if (this.inMemoryState) {
            return this.inMemoryState;
        }

        const state = this.context.globalState.get<ProxyState>('proxyState');
        if (!state) {
            // Migrate from old settings
            return await this.migrateOldSettings();
        }
        return state;
    }

    /**
     * Save proxy state to global storage
     *
     * Requirement 3.2: Falls back to in-memory storage on failure
     *
     * @param {ProxyState} state - State to save
     */
    async saveState(state: ProxyState): Promise<void> {
        try {
            await this.context.globalState.update('proxyState', state);
            // Clear in-memory fallback on successful write
            this.inMemoryState = null;
        } catch (error) {
            // Requirement 3.2: Log error and continue with in-memory state
            Logger.error('Failed to write proxy state to global storage:', error);
            Logger.log('Continuing with in-memory state as fallback');
            this.inMemoryState = { ...state };

            // Notify user about the issue (only if vscode.window is available)
            try {
                const i18n = I18nManager.getInstance();
                vscode.window.showWarningMessage(
                    i18n.t('warning.unableToPersist'),
                    i18n.t('action.ok')
                );
            } catch (notificationError) {
                // In test environment, vscode.window may not be available
                Logger.log('Unable to show warning message (test environment)');
            }
        }
    }

    /**
     * Get the active proxy URL based on current mode
     *
     * @param {ProxyState} state - Current proxy state
     * @returns {string} Active proxy URL or empty string
     */
    getActiveProxyUrl(state: ProxyState): string {
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
     * Get the next mode in the cycle: Off -> Manual -> Auto -> Off
     *
     * @param {ProxyMode} currentMode - Current proxy mode
     * @returns {ProxyMode} Next mode in the cycle
     */
    getNextMode(currentMode: ProxyMode): ProxyMode {
        switch (currentMode) {
            case ProxyMode.Off:
                return ProxyMode.Manual;
            case ProxyMode.Manual:
                return ProxyMode.Auto;
            case ProxyMode.Auto:
                return ProxyMode.Off;
            default:
                return ProxyMode.Off;
        }
    }

    /**
     * Migrate from old settings format to new ProxyState format
     *
     * Requirement 3.3: Transparent migration from legacy settings
     *
     * @returns {Promise<ProxyState>} Migrated state
     */
    private async migrateOldSettings(): Promise<ProxyState> {
        const oldEnabled = this.context.globalState.get<boolean>('proxyEnabled', false);
        const config = vscode.workspace.getConfiguration('otakProxy');
        const manualUrl = config.get<string>('proxyUrl', '');

        return {
            mode: oldEnabled && manualUrl ? ProxyMode.Manual : ProxyMode.Off,
            manualProxyUrl: manualUrl,
            autoProxyUrl: undefined,
            lastSystemProxyCheck: undefined,
            gitConfigured: undefined,
            vscodeConfigured: undefined,
            npmConfigured: undefined,
            systemProxyDetected: undefined,
            lastError: undefined
        };
    }
}
