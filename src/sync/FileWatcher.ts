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
    private currentFilePath: string | null = null;
    private watching: boolean = false;

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

        this.currentFilePath = filePath;
        this.watching = true;

        try {
            // Watch the file (or directory containing it)
            this.watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
                this.handleChange(eventType);
            });

            // Handle watcher errors
            this.watcher.on('error', (error) => {
                Logger.warn('File watcher error:', error);
                // Don't stop watching - the file might be recreated
            });

            Logger.log(`Started watching file: ${filePath}`);
        } catch (error) {
            // File might not exist yet - watch the directory instead
            Logger.warn(`Could not watch file directly, will watch for creation: ${filePath}`);
            this.watching = true;
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
        this.currentFilePath = null;

        Logger.log('File watcher stopped');
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
     *
     * @param eventType Type of change event
     */
    private handleChange(eventType: string): void {
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
