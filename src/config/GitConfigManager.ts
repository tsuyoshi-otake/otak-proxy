import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Result of a Git configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'UNKNOWN';
}

/**
 * Manages Git proxy configuration with secure command execution.
 * Uses execFile() instead of exec() to prevent shell interpretation and command injection.
 */
export class GitConfigManager {
    private readonly timeout: number = 5000; // 5 seconds timeout

    /**
     * Sets Git global proxy configuration for both http and https
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            // Set http.proxy
            await execFileAsync('git', ['config', '--global', 'http.proxy', url], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            // Set https.proxy
            await execFileAsync('git', ['config', '--global', 'https.proxy', url], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            return { success: true };
        } catch (error: any) {
            return this.handleError(error);
        }
    }

    /**
     * Removes Git global proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(): Promise<OperationResult> {
        try {
            // Unset http.proxy (git config --unset is idempotent - safe to call even if key doesn't exist)
            try {
                await execFileAsync('git', ['config', '--global', '--unset', 'http.proxy'], {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
            } catch (error: any) {
                // Ignore error if key doesn't exist (exit code 5)
                if (error.code !== 5) {
                    throw error;
                }
            }

            // Unset https.proxy
            try {
                await execFileAsync('git', ['config', '--global', '--unset', 'https.proxy'], {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
            } catch (error: any) {
                // Ignore error if key doesn't exist (exit code 5)
                if (error.code !== 5) {
                    throw error;
                }
            }

            return { success: true };
        } catch (error: any) {
            return this.handleError(error);
        }
    }

    /**
     * Gets current Git proxy configuration
     * @returns Current proxy URL or null if not configured
     */
    async getProxy(): Promise<string | null> {
        try {
            // Try to get http.proxy first
            const { stdout } = await execFileAsync('git', ['config', '--global', '--get', 'http.proxy'], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            return stdout.trim() || null;
        } catch (error: any) {
            // If the config doesn't exist, git returns exit code 1
            // This is not an error, just means no proxy is configured
            if (error.code === 1) {
                return null;
            }

            // For other errors, log but return null
            Logger.error('Error getting Git proxy:', error);
            return null;
        }
    }

    /**
     * Checks if a Git config key exists
     * @param key - Config key to check
     * @returns true if the key exists
     */
    private async hasConfig(key: string): Promise<boolean> {
        try {
            await execFileAsync('git', ['config', '--global', '--get', key], {
                timeout: this.timeout,
                encoding: 'utf8'
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Handles errors from Git command execution and determines error type
     * @param error - Error from execFile
     * @returns OperationResult with error details
     */
    private handleError(error: any): OperationResult {
        const errorMessage = error.message || String(error);
        const stderr = error.stderr || '';

        // Determine error type based on error details
        let errorType: OperationResult['errorType'] = 'UNKNOWN';
        let errorDescription = errorMessage;

        // Check for Git not installed
        if (error.code === 'ENOENT' || errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
            errorType = 'NOT_INSTALLED';
            errorDescription = 'Git is not installed or not in PATH';
        }
        // Check for permission errors
        else if (error.code === 'EACCES' || errorMessage.includes('EACCES') || 
                 stderr.includes('Permission denied') || stderr.includes('permission')) {
            errorType = 'NO_PERMISSION';
            errorDescription = 'Permission denied when accessing Git configuration';
        }
        // Check for timeout
        else if (error.killed || errorMessage.includes('timeout') || error.signal === 'SIGTERM') {
            errorType = 'TIMEOUT';
            errorDescription = 'Git command timed out after 5 seconds';
        }

        return {
            success: false,
            error: errorDescription,
            errorType
        };
    }
}
