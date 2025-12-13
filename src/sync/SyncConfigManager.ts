/**
 * @file SyncConfigManager
 * @description Manages configuration settings for multi-instance synchronization
 *
 * Feature: multi-instance-sync
 * Requirements: 8.1, 8.2, 8.3, 8.4
 *
 * Provides:
 * - Sync enable/disable setting (8.1)
 * - Standalone mode when disabled (8.2)
 * - Sync interval configuration (8.3)
 * - Real-time setting changes without restart (8.4)
 */

import * as vscode from 'vscode';

/**
 * Minimum allowed sync interval in milliseconds
 */
const MIN_SYNC_INTERVAL = 100;

/**
 * Maximum allowed sync interval in milliseconds
 */
const MAX_SYNC_INTERVAL = 5000;

/**
 * Default sync interval in milliseconds
 */
const DEFAULT_SYNC_INTERVAL = 1000;

/**
 * Default sync enabled state
 */
const DEFAULT_SYNC_ENABLED = true;

/**
 * Configuration section name
 */
const CONFIG_SECTION = 'otakProxy';

/**
 * Configuration change listener type
 */
type ConfigChangeListener = (key: string, value: unknown) => void;

/**
 * Interface for SyncConfigManager as defined in design.md
 */
export interface ISyncConfigManager {
    /**
     * Check if sync is enabled
     */
    isSyncEnabled(): boolean;

    /**
     * Get sync interval in milliseconds
     */
    getSyncInterval(): number;

    /**
     * Register a listener for configuration changes
     */
    onConfigChange(listener: ConfigChangeListener): vscode.Disposable;
}

/**
 * SyncConfigManager manages sync-related configuration settings.
 *
 * Responsibilities:
 * - Read syncEnabled and syncInterval from VSCode configuration
 * - Validate and clamp interval values
 * - Notify listeners of configuration changes
 */
export class SyncConfigManager implements ISyncConfigManager {
    private listeners: Set<ConfigChangeListener> = new Set();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        // Set up VSCode configuration change listener
        this.setupConfigChangeWatcher();
    }

    /**
     * Check if multi-instance sync is enabled
     *
     * Requirement 8.1: Enable/disable sync setting
     *
     * @returns True if sync is enabled, false otherwise
     */
    isSyncEnabled(): boolean {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const value = config.get<boolean>('syncEnabled');

        // Return default if value is undefined or not a boolean
        if (typeof value !== 'boolean') {
            return DEFAULT_SYNC_ENABLED;
        }

        return value;
    }

    /**
     * Get the synchronization interval in milliseconds
     *
     * Requirement 8.3: Sync interval setting
     *
     * @returns Sync interval clamped to valid range [100, 5000] ms
     */
    getSyncInterval(): number {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const value = config.get<number>('syncInterval');

        // Return default if value is undefined or not a number
        if (typeof value !== 'number' || isNaN(value)) {
            return DEFAULT_SYNC_INTERVAL;
        }

        // Clamp to valid range
        return Math.max(MIN_SYNC_INTERVAL, Math.min(MAX_SYNC_INTERVAL, value));
    }

    /**
     * Register a listener for configuration changes
     *
     * Requirement 8.4: Real-time setting changes
     *
     * @param listener - Callback function to receive change notifications
     * @returns Disposable to unregister the listener
     */
    onConfigChange(listener: ConfigChangeListener): vscode.Disposable {
        this.listeners.add(listener);

        return {
            dispose: () => {
                this.listeners.delete(listener);
            }
        };
    }

    /**
     * Handle a configuration change (for external notification)
     *
     * @param key - Configuration key that changed
     * @param value - New value
     */
    handleConfigurationChange(key: string, value: unknown): void {
        this.notifyListeners(key, value);
    }

    /**
     * Create a VSCode configuration change listener function
     *
     * @returns Listener function compatible with vscode.workspace.onDidChangeConfiguration
     */
    createVSCodeConfigChangeListener(): (e: vscode.ConfigurationChangeEvent) => void {
        return (e: vscode.ConfigurationChangeEvent) => {
            if (e.affectsConfiguration(`${CONFIG_SECTION}.syncEnabled`)) {
                this.notifyListeners('syncEnabled', this.isSyncEnabled());
            }

            if (e.affectsConfiguration(`${CONFIG_SECTION}.syncInterval`)) {
                this.notifyListeners('syncInterval', this.getSyncInterval());
            }
        };
    }

    /**
     * Set up watcher for VSCode configuration changes
     */
    private setupConfigChangeWatcher(): void {
        const disposable = vscode.workspace.onDidChangeConfiguration(
            this.createVSCodeConfigChangeListener()
        );
        this.disposables.push(disposable);
    }

    /**
     * Notify all registered listeners of a configuration change
     *
     * @param key - Configuration key that changed
     * @param value - New value
     */
    private notifyListeners(key: string, value: unknown): void {
        for (const listener of this.listeners) {
            try {
                listener(key, value);
            } catch (error) {
                // Don't let one listener failure affect others
                console.error('Error in config change listener:', error);
            }
        }
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.listeners.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }
}
