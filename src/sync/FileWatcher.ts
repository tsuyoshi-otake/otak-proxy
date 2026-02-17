/**
 * @file FileWatcher
 * @description Watches shared state file for changes with debouncing
 *
 * Feature: multi-instance-sync
 * Requirements: 5.3, 5.4
 *
 * Provides:
 * - File change detection (5.3)
 * - Continuous monitoring during active session (5.4)
 * - Debounced events to prevent excessive notifications
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';

/**
 * Interface for FileWatcher as defined in design.md
 */
export interface IFileWatcher {
    /**
     * Start watching a file
     * @param filePath Path to the file to watch
     */
    start(filePath: string): void;

    /**
     * Stop watching
     */
    stop(): void;

    /**
     * Check if currently watching
     */
    isWatching(): boolean;

    /**
     * Register a change event listener
     */
    on(event: 'change', listener: () => void): void;

    /**
     * Remove a change event listener
     */
    off(event: 'change', listener: () => void): void;
}

/**
 * Debounce delay in milliseconds
 */
const DEBOUNCE_DELAY = 100;

/**
 * FileWatcher monitors a file for changes using fs.watch.
 *
 * Features:
 * - Debounces rapid changes to prevent excessive event firing
 * - Handles platform differences in fs.watch behavior
 * - Graceful error handling for missing/deleted files
 */
export class FileWatcher implements IFileWatcher {
    private watcher: fs.FSWatcher | null = null;
    private listeners: Set<() => void> = new Set();
    private debounceTimer: NodeJS.Timeout | null = null;
    private watching: boolean = false;

    private attachErrorHandler(): void {
        if (!this.watcher) {
            return;
        }
        this.watcher.on('error', (error) => {
            Logger.warn('File watcher error:', error);
            // Don't stop watching - the file might be recreated
        });
    }

    /**
     * Start watching a file for changes
     *
     * @param filePath Path to the file to watch
     */
    start(filePath: string): void {
        // Stop any existing watcher
        if (this.watcher) {
            this.stop();
        }

        this.watching = true;

        const dirPath = path.dirname(filePath);
        const targetFile = path.basename(filePath);

        try {
            this.watcher = fs.watch(filePath, { persistent: false }, () => {
                this.handleChange();
            });
            this.attachErrorHandler();
            Logger.debug(`Started watching file: ${filePath}`);
            return;
        } catch (error) {
            // File might not exist yet - fall back to watching the directory.
            Logger.debug(`Could not watch file directly, falling back to directory watch: ${filePath}`);
        }

        try {
            this.watcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
                if (filename) {
                    const name = Buffer.isBuffer(filename) ? filename.toString() : filename;
                    if (name && name !== targetFile) {
                        return;
                    }
                }
                this.handleChange();
            });
            this.attachErrorHandler();
            Logger.debug(`Started watching directory: ${dirPath} (target: ${targetFile})`);
        } catch (error) {
            // Watcher could not be started (directory missing, permissions, etc.). Keep watching=true but log.
            Logger.warn(`Could not watch file or directory: ${filePath}`, error);
        }
    }

    /**
     * Stop watching the file
     */
    stop(): void {
        // Clear debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        // Close watcher
        if (this.watcher) {
            try {
                this.watcher.close();
            } catch {
                // Ignore close errors
            }
            this.watcher = null;
        }

        this.watching = false;

        Logger.debug('File watcher stopped');
    }

    /**
     * Check if currently watching a file
     */
    isWatching(): boolean {
        return this.watching;
    }

    /**
     * Register a change event listener
     *
     * @param event Event type (only 'change' is supported)
     * @param listener Callback function
     */
    on(event: 'change', listener: () => void): void {
        if (event === 'change') {
            this.listeners.add(listener);
        }
    }

    /**
     * Remove a change event listener
     *
     * @param event Event type (only 'change' is supported)
     * @param listener Callback function to remove
     */
    off(event: 'change', listener: () => void): void {
        if (event === 'change') {
            this.listeners.delete(listener);
        }
    }

    /**
     * Handle a file change event
     */
    private handleChange(): void {
        // Debounce: reset timer on each change
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Set up debounced notification
        this.debounceTimer = setTimeout(() => {
            this.notifyListeners();
            this.debounceTimer = null;
        }, DEBOUNCE_DELAY);
    }

    /**
     * Notify all registered listeners of a change
     */
    private notifyListeners(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                Logger.error('Error in file change listener:', error);
            }
        }
    }
}
