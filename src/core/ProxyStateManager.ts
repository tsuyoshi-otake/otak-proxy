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
import {
    getProxyPublicUrl,
    hasProxyCredentials,
    sanitizeProxyStateForPersistence
} from '../utils/ProxyStateSanitizer';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';
import { V3MigrationService, LEGACY_MANUAL_PROXY_SECRET_KEY } from './V3MigrationService';

/**
 * ProxyStateManager handles all proxy state operations
 *
 * Requirement 3.1: Centralized state management
 * Requirement 3.2: Automatic in-memory fallback on storage failure
 * Requirement 3.3: Transparent migration from legacy settings
 */
export class ProxyStateManager implements IProxyStateManager {
    private inMemoryState: ProxyState | null = null;
    private readonly credentialStore: ProxyCredentialStore;

    constructor(private context: vscode.ExtensionContext) {
        this.credentialStore = new ProxyCredentialStore(context.secrets);
    }

    /**
     * Get the current proxy state
     *
     * Requirement 3.2: Returns in-memory fallback if available
     * Requirement 3.3: Migrates from old settings if needed
     *
     * @returns {Promise<ProxyState>} Current proxy state
     */
    async getState(): Promise<ProxyState> {
        await new V3MigrationService(this.context).migrateIfNeeded();

        // If we have an in-memory fallback state, use it
        if (this.inMemoryState) {
            const hydratedState = await this.hydrateStateForRuntime(this.inMemoryState);
            const migratedState = this.migrateManualModeToAuto(hydratedState);
            this.inMemoryState = { ...migratedState };
            return migratedState;
        }

        const state = this.context.globalState.get<ProxyState>('proxyState');
        if (!state) {
            // Migrate from old settings
            const migratedState = await this.migrateOldSettings();
            const normalizedState = this.migrateManualModeToAuto(migratedState);
            if (normalizedState.mode !== migratedState.mode) {
                await this.saveState(normalizedState);
            }
            return normalizedState;
        }
        const hydratedState = await this.hydrateStateForRuntime(state);
        const migratedState = this.migrateManualModeToAuto(hydratedState);
        if (migratedState.mode !== hydratedState.mode) {
            await this.saveState(migratedState);
            return migratedState;
        }

        await this.scrubPersistedStateIfNeeded(state);
        return migratedState;
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
            await this.persistManualProxySecret(state.manualProxyUrl);
            await this.context.globalState.update('proxyState', sanitizeProxyStateForPersistence(state));
            // Keep the full state only in memory for the current session. Persistent state is sanitized.
            this.inMemoryState = { ...state };
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
                if (state.autoModeOff === true) {
                    return '';
                }
                return state.autoProxyUrl || '';
            case ProxyMode.Manual:
                return state.manualProxyUrl || '';
            default:
                return '';
        }
    }

    /**
     * Get the next mode in the cycle: Off -> Auto -> Off
     * Legacy Manual states are migrated to Auto when loaded; if encountered at
     * runtime, they also move to Auto on the next toggle.
     *
     * @param {ProxyMode} currentMode - Current proxy mode
     * @returns {ProxyMode} Next mode in the cycle
     */
    getNextMode(currentMode: ProxyMode): ProxyMode {
        switch (currentMode) {
            case ProxyMode.Off:
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
        const manualUrl = await this.normalizeConfiguredManualProxyUrl(config.get<string>('proxyUrl', ''));

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

    private migrateManualModeToAuto(state: ProxyState): ProxyState {
        if (state.mode !== ProxyMode.Manual) {
            return state;
        }

        return {
            ...state,
            mode: ProxyMode.Auto
        };
    }

    private async hydrateStateForRuntime(state: ProxyState): Promise<ProxyState> {
        const config = vscode.workspace.getConfiguration('otakProxy');
        const configuredManualUrl = await this.normalizeConfiguredManualProxyUrl(config.get<string>('proxyUrl', ''));

        if (state.manualProxyUrl && hasProxyCredentials(state.manualProxyUrl)) {
            return state;
        }

        const configuredPublicUrl = getProxyPublicUrl(configuredManualUrl);
        const statePublicUrl = getProxyPublicUrl(state.manualProxyUrl);
        const secretManualUrl = await this.getManualProxySecret(statePublicUrl || configuredPublicUrl);
        const secretPublicUrl = getProxyPublicUrl(secretManualUrl);

        if (secretManualUrl && statePublicUrl && secretPublicUrl === statePublicUrl) {
            return {
                ...state,
                manualProxyUrl: secretManualUrl
            };
        }

        if (configuredManualUrl && (!state.manualProxyUrl || state.manualProxyUrl === configuredPublicUrl)) {
            return {
                ...state,
                manualProxyUrl: secretManualUrl && secretPublicUrl === configuredPublicUrl
                    ? secretManualUrl
                    : configuredManualUrl
            };
        }

        return state;
    }

    private async scrubPersistedStateIfNeeded(state: ProxyState): Promise<void> {
        const sanitizedState = sanitizeProxyStateForPersistence(state);
        if (JSON.stringify(sanitizedState) === JSON.stringify(state)) {
            return;
        }

        try {
            await this.persistManualProxySecret(state.manualProxyUrl);
            await this.context.globalState.update('proxyState', sanitizedState);
        } catch (error) {
            Logger.warn('Failed to scrub proxy credentials from persisted state:', error);
        }
    }

    private async normalizeConfiguredManualProxyUrl(configuredManualUrl: string): Promise<string> {
        if (!configuredManualUrl) {
            return '';
        }

        if (!hasProxyCredentials(configuredManualUrl)) {
            return configuredManualUrl;
        }

        await this.storeManualProxySecret(configuredManualUrl);
        const publicUrl = getProxyPublicUrl(configuredManualUrl) || configuredManualUrl;

        try {
            await vscode.workspace.getConfiguration('otakProxy').update(
                'proxyUrl',
                publicUrl,
                vscode.ConfigurationTarget.Global
            );
        } catch (error) {
            Logger.warn('Failed to remove proxy credentials from configuration:', error);
        }

        return configuredManualUrl;
    }

    private async persistManualProxySecret(manualProxyUrl: string | undefined): Promise<void> {
        if (!manualProxyUrl) {
            await this.deleteManualProxySecret();
            return;
        }

        if (hasProxyCredentials(manualProxyUrl)) {
            await this.storeManualProxySecret(manualProxyUrl);
            return;
        }

        const existing = await this.getManualProxySecret();
        if (existing && getProxyPublicUrl(existing) !== getProxyPublicUrl(manualProxyUrl)) {
            await this.deleteManualProxySecret();
        }
    }

    private async getManualProxySecret(publicUrl?: string): Promise<string | undefined> {
        if (publicUrl) {
            const reconstructed = await this.credentialStore.reconstructProxyUrl(publicUrl);
            if (reconstructed) {
                return reconstructed;
            }
        }

        return await this.getLegacyManualProxySecret();
    }

    private async getLegacyManualProxySecret(): Promise<string | undefined> {
        const secrets = this.context.secrets;
        if (!secrets || typeof secrets.get !== 'function') {
            return undefined;
        }
        try {
            return await secrets.get(LEGACY_MANUAL_PROXY_SECRET_KEY);
        } catch (error) {
            Logger.warn('Failed to read proxy credentials from secret storage:', error);
            return undefined;
        }
    }

    private async storeManualProxySecret(manualProxyUrl: string): Promise<void> {
        const secrets = this.context.secrets;
        if (!secrets || typeof secrets.store !== 'function') {
            Logger.warn('Secret storage is not available; proxy credentials cannot be stored securely.');
            return;
        }
        try {
            await this.credentialStore.storeFromProxyUrl(manualProxyUrl);
        } catch (error) {
            Logger.warn('Failed to store proxy credentials in secret storage:', error);
        }
    }

    private async deleteManualProxySecret(): Promise<void> {
        const secrets = this.context.secrets;
        if (!secrets || typeof secrets.delete !== 'function') {
            return;
        }
        try {
            await secrets.delete(LEGACY_MANUAL_PROXY_SECRET_KEY);
        } catch (error) {
            Logger.warn('Failed to delete proxy credentials from secret storage:', error);
        }
    }
}
