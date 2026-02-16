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
 * Uses execFile() with shell:true on Windows to handle npm.cmd batch file.
 * Arguments are passed as array to prevent command injection.
 * 
 * Note: npm 11.x uses 'proxy' instead of 'http-proxy' for HTTP proxy settings.
 */
export class NpmConfigManager {
    private readonly timeout: number = 5000; // 5 seconds timeout
    private readonly isWindows: boolean = process.platform === 'win32';

    /**
     * Executes npm command with platform-appropriate options.
     * On Windows, npm is a batch file (.cmd) so shell:true is required.
     */
    private async execNpm(args: string[]): Promise<{ stdout: string; stderr: string }> {
        return execFileAsync('npm', args, {
            timeout: this.timeout,
            encoding: 'utf8',
            shell: this.isWindows  // Required for Windows to execute npm.cmd
        });
    }

    /**
     * Sets npm proxy configuration for both proxy and https-proxy
     * Note: npm 11.x uses 'proxy' (not 'http-proxy') for HTTP proxy
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            // Set proxy (for HTTP - npm 11.x naming)
            await this.execNpm(['config', 'set', 'proxy', url]);

            // Set https-proxy
            await this.execNpm(['config', 'set', 'https-proxy', url]);

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
            // Delete proxy (npm delete is idempotent - safe to call even if key doesn't exist)
            try {
                await this.execNpm(['config', 'delete', 'proxy']);
            } catch (error: any) {
                // Ignore errors if key doesn't exist
                if (!error.stderr?.includes('not found') && error.code !== 1) {
                    throw error;
                }
            }

            // Delete https-proxy
            try {
                await this.execNpm(['config', 'delete', 'https-proxy']);
            } catch (error: any) {
                // Ignore errors if key doesn't exist
                if (!error.stderr?.includes('not found') && error.code !== 1) {
                    throw error;
                }
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
            // npm 11.x protects the 'proxy' option, so we use 'npm config list' instead
            const { stdout } = await this.execNpm(['config', 'list', '--json']);

            const config = JSON.parse(stdout);
            const normalizeValue = (value: any): string | null => {
                if (value === undefined || value === null) {
                    return null;
                }
                const str = typeof value === 'string' ? value : String(value);
                const trimmed = str.trim();
                // npm returns 'null' or 'undefined' as a string when config doesn't exist
                if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') {
                    return null;
                }
                return trimmed;
            };

            // Prefer HTTP proxy setting, but fall back to https-proxy if only that is configured.
            const proxy = normalizeValue(config.proxy);
            const httpsProxy = normalizeValue(config['https-proxy']);

            return proxy ?? httpsProxy;
        } catch (error: any) {
            // For errors, log but return null
            Logger.error('Error getting npm proxy:', error);
            return null;
        }
    }

    /**
     * Checks if an npm config key exists
     * @param key - Config key to check
     * @returns true if the key exists and has a value
     */
    private async hasConfig(key: string): Promise<boolean> {
        try {
            const { stdout } = await this.execNpm(['config', 'get', key]);

            const value = stdout.trim();
            // npm returns 'null' or 'undefined' as a string when config doesn't exist
            return value !== '' && value !== 'undefined' && value !== 'null';
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
