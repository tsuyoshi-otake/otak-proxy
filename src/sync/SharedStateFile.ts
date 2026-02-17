/**
 * @file SharedStateFile
 * @description Provides atomic read/write operations for shared state file
 *
 * Feature: multi-instance-sync
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 *
 * Provides:
 * - File-based sync mechanism (5.1)
 * - Atomic file access (5.2)
 * - File change detection support (5.3, 5.4)
 * - Graceful failure handling (5.5)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProxyState, ProxyTestResult } from '../core/types';
import { Logger } from '../utils/Logger';
import { getErrorCode } from '../utils/ErrorUtils';

/**
 * Shared state structure stored in JSON file
 */
export interface SharedState {
    /** Monotonic state version for conflict resolution */
    version: number;
    /** Unix timestamp (ms) of last modification */
    lastModified: number;
    /** Instance ID that made the last modification */
    lastModifiedBy: string;
    /** The synchronized proxy state */
    proxyState: ProxyState;
    /** Optional: Last connection test result */
    testResult?: ProxyTestResult;
}

/**
 * Interface for SharedStateFile as defined in design.md
 */
export interface ISharedStateFile {
    /**
     * Read shared state from file
     * @returns Shared state or null if file doesn't exist or is invalid
     */
    read(): Promise<SharedState | null>;

    /**
     * Write shared state to file atomically
     * @param state State to write
     */
    write(state: SharedState): Promise<void>;

    /**
     * Check if state file exists
     */
    exists(): Promise<boolean>;

    /**
     * Recover from corrupted file
     * @returns True if recovery was performed, false if nothing to recover
     */
    recover(): Promise<boolean>;

    /**
     * Get the file path for external use (e.g., file watcher)
     */
    getFilePath(): string;
}

/**
 * Sync directory name
 */
const SYNC_DIR_NAME = 'otak-proxy-sync';

/**
 * State file name
 */
const STATE_FILE_NAME = 'sync-state.json';

/**
 * Temp file suffix for atomic writes
 */
const TEMP_FILE_SUFFIX = '.tmp';

/**
 * Atomic rename can be flaky on Windows when AV or indexers temporarily lock the file.
 * Retry a few times for EPERM/EACCES to reduce test/usage flakes.
 */
const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 25;

/**
 * SharedStateFile provides atomic read/write operations for the shared state file.
 *
 * Uses write-then-rename pattern for atomic writes to prevent corruption
 * during concurrent access from multiple instances.
 */
export class SharedStateFile implements ISharedStateFile {
    private readonly syncDir: string;
    private readonly stateFilePath: string;

    /**
     * Create a new SharedStateFile instance
     *
     * @param baseDir Base directory (typically globalStorageUri.fsPath)
     */
    constructor(baseDir: string) {
        this.syncDir = path.join(baseDir, SYNC_DIR_NAME);
        this.stateFilePath = path.join(this.syncDir, STATE_FILE_NAME);
    }

    /**
     * Read shared state from file
     *
     * @returns Shared state or null if file doesn't exist or is invalid
     */
    async read(): Promise<SharedState | null> {
        try {
            // Check if file exists
            if (!fs.existsSync(this.stateFilePath)) {
                return null;
            }

            // Read file content
            const content = fs.readFileSync(this.stateFilePath, 'utf-8');

            // Handle empty file
            if (!content || content.trim() === '') {
                Logger.warn('Shared state file is empty');
                return null;
            }

            // Parse JSON
            const state = JSON.parse(content) as SharedState;

            // Validate required fields
            if (!this.isValidState(state)) {
                Logger.warn('Shared state file has invalid structure');
                return null;
            }

            return state;
        } catch (error) {
            if (error instanceof SyntaxError) {
                Logger.error('Failed to parse shared state file:', error);
            } else {
                Logger.error('Failed to read shared state file:', error);
            }
            return null;
        }
    }

    /**
     * Write shared state to file atomically
     *
     * Uses write-then-rename pattern:
     * 1. Write to temp file
     * 2. Rename temp file to actual file (atomic operation on most file systems)
     *
     * @param state State to write
     */
    async write(state: SharedState): Promise<void> {
        const tempPath = path.join(
            this.syncDir,
            `${STATE_FILE_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}${TEMP_FILE_SUFFIX}`
        );
        try {
            // Ensure sync directory exists
            await this.ensureSyncDir();

            // Serialize state
            const content = JSON.stringify(state, null, 2);

            // Write to temp file first
            fs.writeFileSync(tempPath, content, 'utf-8');

            // Atomic rename (this is the key to atomic writes)
            for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt++) {
                try {
                    fs.renameSync(tempPath, this.stateFilePath);
                    return;
                } catch (error) {
                    const code = getErrorCode(error);
                    const shouldRetry = (code === 'EPERM' || code === 'EACCES') && attempt < RENAME_RETRY_ATTEMPTS - 1;
                    if (!shouldRetry) {
                        throw error;
                    }
                    await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
                }
            }

        } catch (error) {
            Logger.error('Failed to write shared state file:', error);

            // Clean up temp file if it exists
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // Ignore cleanup errors
            }

            throw error;
        }
    }

    /**
     * Check if state file exists
     */
    async exists(): Promise<boolean> {
        return fs.existsSync(this.stateFilePath);
    }

    /**
     * Recover from corrupted file
     *
     * Attempts to:
     * 1. Delete corrupted file
     * 2. Clean up any temp files
     *
     * @returns True if recovery was performed, false if nothing to recover
     */
    async recover(): Promise<boolean> {
        let recovered = false;

        try {
            // Check if state file exists
            if (fs.existsSync(this.stateFilePath)) {
                // Try to read it
                const state = await this.read();

                if (state === null) {
                    // File exists but is corrupted - delete it
                    Logger.info('Recovering from corrupted state file');
                    fs.unlinkSync(this.stateFilePath);
                    recovered = true;
                }
            }

            // Clean up any temp files
            if (fs.existsSync(this.syncDir)) {
                const files = fs.readdirSync(this.syncDir);
                for (const file of files) {
                    if (!file.includes(TEMP_FILE_SUFFIX)) {
                        continue;
                    }
                    try {
                        fs.unlinkSync(path.join(this.syncDir, file));
                        recovered = true;
                    } catch {
                        // Ignore cleanup errors
                    }
                }
            }

        } catch (error) {
            Logger.error('Error during recovery:', error);
        }

        return recovered;
    }

    /**
     * Get the file path for external use (e.g., file watcher)
     */
    getFilePath(): string {
        return this.stateFilePath;
    }

    /**
     * Get the sync directory path
     */
    getSyncDir(): string {
        return this.syncDir;
    }

    /**
     * Ensure the sync directory exists
     */
    private async ensureSyncDir(): Promise<void> {
        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }
    }

    /**
     * Validate that state has required fields
     */
    private isValidState(state: unknown): state is SharedState {
        if (typeof state !== 'object' || state === null) {
            return false;
        }

        const s = state as Record<string, unknown>;

        // Check required fields
        if (typeof s.version !== 'number') {
            return false;
        }

        if (typeof s.lastModified !== 'number') {
            return false;
        }

        if (typeof s.lastModifiedBy !== 'string') {
            return false;
        }

        if (typeof s.proxyState !== 'object' || s.proxyState === null) {
            return false;
        }

        // ProxyState must have mode
        const proxyState = s.proxyState as Record<string, unknown>;
        if (typeof proxyState.mode !== 'string') {
            return false;
        }

        return true;
    }
}
