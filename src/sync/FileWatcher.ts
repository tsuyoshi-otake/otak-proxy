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
 * Poll interval used only by the degraded fallback path (network shares, file
 * systems without change notifications). The primary path is event driven and
 * costs no CPU while idle, so this only has to bound worst-case staleness.
 */
const FALLBACK_POLL_INTERVAL = 2000;

/**
 * Compares two directory entry names the way the host file system does.
 *
 * Windows and macOS report the changed entry with whatever casing the OS has
 * recorded, which is not necessarily the casing we resolved the path with.
 */
function isSameFileName(a: string, b: string): boolean {
    if (process.platform === 'win32' || process.platform === 'darwin') {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}

/**
 * FileWatcher monitors a file for changes.
 *
 * Primary mechanism is an OS change-notification watch on the *containing
 * directory* (inotify / ReadDirectoryChangesW): it costs no CPU while idle and,
 * unlike watching the file inode directly, it survives the write-then-rename
 * pattern SharedStateFile uses for atomic updates.
 *
 * Features:
 * - Event-driven watching with a stat-polling fallback when fs.watch is unsupported
 * - Debounces rapid changes to prevent excessive event firing
 * - Handles file deletion and recreation during atomic writes
 * - Graceful error handling for missing/deleted files
 */
export class FileWatcher implements IFileWatcher {
    private watchedFilePath: string | null = null;
    private watchFileListener: ((curr: fs.Stats, prev: fs.Stats) => void) | null = null;
    private directoryWatcher: fs.FSWatcher | null = null;
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

        const resolvedFilePath = path.resolve(filePath);
        this.watchedFilePath = resolvedFilePath;

        if (this.startDirectoryWatch(resolvedFilePath)) {
            return;
        }

        this.startPollingFallback(resolvedFilePath);
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
        if (this.directoryWatcher) {
            try {
                this.directoryWatcher.close();
            } catch {
                // Ignore close errors
            }
            this.directoryWatcher = null;
        }

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
     * Watch the containing directory using OS change notifications.
     *
     * @returns true when the event-driven watch is active
     */
    private startDirectoryWatch(resolvedFilePath: string): boolean {
        const directory = this.resolveWatchDirectory(path.dirname(resolvedFilePath));
        if (!directory) {
            return false;
        }

        const fileName = path.basename(resolvedFilePath);

        try {
            const watcher = fs.watch(directory, { persistent: false });
            watcher.on('change', (_eventType, changedName) => {
                // changedName is null on platforms that do not report the entry
                // name; treat that as "something in the directory changed".
                if (changedName && !isSameFileName(path.basename(String(changedName)), fileName)) {
                    return;
                }
                this.handleChange();
            });
            watcher.on('error', (error) => {
                Logger.warn(`File watch failed, falling back to polling: ${directory}`, error);
                this.degradeToPolling(resolvedFilePath);
            });

            this.directoryWatcher = watcher;
            Logger.debug(`Started watching directory for changes: ${directory}`);
            return true;
        } catch (error) {
            Logger.debug(`fs.watch unavailable for ${directory}, using polling fallback`, error);
            return false;
        }
    }

    /**
     * Resolves the directory to the path the OS itself reports.
     *
     * On Windows, watching a path that contains an 8.3 short component (e.g.
     * `C:\Users\DEVELO~1\...`) aborts the process inside libuv, because the
     * long name reported by the change notification does not match the short
     * name the watch was registered with. Resolving to the native real path
     * first avoids that; if the directory does not exist yet (or cannot be
     * resolved) the caller falls back to polling.
     *
     * @returns The resolved directory, or null when it cannot be watched
     */
    private resolveWatchDirectory(directory: string): string | null {
        try {
            return fs.realpathSync.native(directory);
        } catch (error) {
            Logger.debug(`Cannot resolve directory for watching: ${directory}`, error);
            return null;
        }
    }

    /**
     * Degrade an already-started directory watch to stat polling.
     */
    private degradeToPolling(resolvedFilePath: string): void {
        if (!this.watching || this.watchFileListener) {
            return;
        }

        if (this.directoryWatcher) {
            try {
                this.directoryWatcher.close();
            } catch {
                // Ignore close errors
            }
            this.directoryWatcher = null;
        }

        this.startPollingFallback(resolvedFilePath);
    }

    /**
     * Stat-polling fallback for file systems without change notifications.
     */
    private startPollingFallback(resolvedFilePath: string): void {
        try {
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

            fs.watchFile(
                resolvedFilePath,
                { interval: FALLBACK_POLL_INTERVAL, persistent: false },
                this.watchFileListener
            );
            Logger.debug(`Started polling file: ${resolvedFilePath}`);
        } catch (error) {
            this.watchFileListener = null;
            Logger.warn(`Could not watch file: ${resolvedFilePath}`, error);
        }
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
