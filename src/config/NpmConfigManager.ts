import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Result of an npm configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'CONFIG_ERROR' | 'UNKNOWN';
}

/**
 * Manages npm proxy configuration with secure command execution.
 * Uses execFile() instead of exec() to prevent shell interpretation and command injection.
 */
export class NpmConfigManager {
    private readonly timeout: number = 5000; // 5 seconds timeout

    /**
     * Sets npm proxy configuration for both http-proxy and https-proxy
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            // Set http-proxy
            await execFileAsync('npm', ['config', 'set', 'http-proxy', url], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            // Set https-proxy
            await execFileAsync('npm', ['config', 'set', 'https-proxy', url], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            return { success: true };
        } catch (error: any) {
            return this.handleError(error);
        }
    }

    /**
     * Removes npm proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(): Promise<OperationResult> {
        try {
            // Check if http-proxy exists
            const hasHttpProxy = await this.hasConfig('http-proxy');
            const hasHttpsProxy = await this.hasConfig('https-proxy');

            // Delete http-proxy if it exists
            if (hasHttpProxy) {
                await execFileAsync('npm', ['config', 'delete', 'http-proxy'], {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
            }

            // Delete https-proxy if it exists
            if (hasHttpsProxy) {
                await execFileAsync('npm', ['config', 'delete', 'https-proxy'], {
                    timeout: this.timeout,
                    encoding: 'utf8'
                });
            }

            return { success: true };
        } catch (error: any) {
            return this.handleError(error);
        }
    }

    /**
     * Gets current npm proxy configuration
     * @returns Current proxy URL or null if not configured
     */
    async getProxy(): Promise<string | null> {
        try {
            // Try to get http-proxy
            const { stdout } = await execFileAsync('npm', ['config', 'get', 'http-proxy'], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            const value = stdout.trim();
            
            // npm returns 'undefined' as a string when config doesn't exist
            if (!value || value === 'undefined') {
                return null;
            }

            return value;
        } catch (error: any) {
            // For errors, log but return null
            Logger.error('Error getting npm proxy:', error);
            return null;
        }
    }

    /**
     * Checks if an npm config key exists
     * @param key - Config key to check
     * @returns true if the key exists
     */
    private async hasConfig(key: string): Promise<boolean> {
        try {
            const { stdout } = await execFileAsync('npm', ['config', 'get', key], {
                timeout: this.timeout,
                encoding: 'utf8'
            });

            const value = stdout.trim();
            // npm returns 'undefined' as a string when config doesn't exist
            return value !== '' && value !== 'undefined';
        } catch {
            return false;
        }
    }

    /**
     * Handles errors from npm command execution and determines error type
     * @param error - Error from execFile
     * @returns OperationResult with error details
     */
    private handleError(error: any): OperationResult {
        const errorMessage = error.message || String(error);
        const stderr = error.stderr || '';

        // Determine error type based on error details
        let errorType: OperationResult['errorType'] = 'UNKNOWN';
        let errorDescription = errorMessage;

        // Check for npm not installed
        if (error.code === 'ENOENT' || errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
            errorType = 'NOT_INSTALLED';
            errorDescription = 'npm is not installed or not in PATH';
        }
        // Check for permission errors
        else if (error.code === 'EACCES' || errorMessage.includes('EACCES') || 
                 stderr.includes('Permission denied') || stderr.includes('permission')) {
            errorType = 'NO_PERMISSION';
            errorDescription = 'Permission denied when accessing npm configuration';
        }
        // Check for timeout
        else if (error.killed || errorMessage.includes('timeout') || error.signal === 'SIGTERM') {
            errorType = 'TIMEOUT';
            errorDescription = 'npm command timed out after 5 seconds';
        }
        // Check for config errors
        else if (stderr.includes('config') || errorMessage.includes('config')) {
            errorType = 'CONFIG_ERROR';
            errorDescription = 'Failed to read/write npm configuration';
        }

        return {
            success: false,
            error: errorDescription,
            errorType
        };
    }
}
