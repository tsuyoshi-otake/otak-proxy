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
 * FileWatcher monitors a file for changes using stat polling.
 *
 * Features:
 * - Debounces rapid changes to prevent excessive event firing
 * - Handles file deletion and recreation during atomic writes
 * - Graceful error handling for missing/deleted files
 */
export class FileWatcher implements IFileWatcher {
    private watchedFilePath: string | null = null;
    private watchFileListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;
    private listeners: Set<() => void> = new Set();
    private debounceTimer: NodeJS.Timeout | null = null;
    private watching: boolean = false;

    /**
     * Start watching a file for changes
     *
     * @param filePath Path to the file to watch
     */
    start(filePath: string): void {
        // Stop any existing watcher
        if (this.watchedFilePath) {
            this.stop();
        }

        this.watching = true;

        try {
            const resolvedFilePath = path.resolve(filePath);
            this.watchFileListener = (curr, prev) => {
                if (
                    curr.mtimeMs === prev.mtimeMs &&
                    curr.size === prev.size &&
                    curr.ino === prev.ino
                ) {
                    return;
                }
                this.handleChange();
            };

            fs.watchFile(resolvedFilePath, { interval: 50, persistent: false }, this.watchFileListener);
            this.watchedFilePath = resolvedFilePath;
            Logger.debug(`Started polling file: ${resolvedFilePath}`);
        } catch (error) {
            Logger.warn(`Could not watch file: ${filePath}`, error);
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

        // Stop watcher
        if (this.watchedFilePath && this.watchFileListener) {
            try {
                fs.unwatchFile(this.watchedFilePath, this.watchFileListener);
            } catch {
                // Ignore unwatch errors
            }
        }
        this.watchedFilePath = null;
        this.watchFileListener = null;

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
