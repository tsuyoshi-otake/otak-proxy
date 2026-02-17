import * as vscode from 'vscode';
import { Logger } from '../utils/Logger';
import { getErrorMessage } from '../utils/ErrorUtils';

/**
 * Result of a VSCode configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'CONFIG_WRITE_FAILED' | 'CONFIG_READ_FAILED' | 'UNKNOWN';
}

/**
 * Manages VSCode proxy configuration with comprehensive error handling.
 * Uses VSCode configuration API to manage http.proxy settings.
 */
export class VscodeConfigManager {
    /**
     * Sets VSCode global proxy configuration
     * @param url - Validated proxy URL
     * @returns Result with success status and any errors
     */
    async setProxy(url: string): Promise<OperationResult> {
        try {
            const config = vscode.workspace.getConfiguration('http');
            await config.update('proxy', url, vscode.ConfigurationTarget.Global);
            
            return { success: true };
        } catch (error) {
            return this.handleError(error, 'set');
        }
    }

    /**
     * Removes VSCode global proxy configuration
     * @returns Result with success status and any errors
     */
    async unsetProxy(): Promise<OperationResult> {
        try {
            const config = vscode.workspace.getConfiguration('http');
            await config.update('proxy', '', vscode.ConfigurationTarget.Global);
            
            return { success: true };
        } catch (error) {
            return this.handleError(error, 'unset');
        }
    }

    /**
     * Gets current VSCode proxy configuration
     * @returns Current proxy URL or null if not configured
     */
    async getProxy(): Promise<string | null> {
        try {
            const config = vscode.workspace.getConfiguration('http');
            const proxy = config.get<string>('proxy');
            
            // Return null if proxy is empty string or undefined
            return proxy && proxy.trim() !== '' ? proxy : null;
        } catch (error) {
            Logger.error('Error getting VSCode proxy:', error);
            return null;
        }
    }

    /**
     * Handles errors from VSCode configuration operations
     * @param error - Error from configuration API
     * @param operation - The operation that failed ('set', 'unset', or 'get')
     * @returns OperationResult with error details
     */
    private handleError(error: unknown, operation: 'set' | 'unset' | 'get'): OperationResult {
        const errorMessage = getErrorMessage(error);
        
        let errorType: OperationResult['errorType'] = 'UNKNOWN';
        let errorDescription = errorMessage;

        // Check for configuration write failures
        if (operation === 'set' || operation === 'unset') {
            errorType = 'CONFIG_WRITE_FAILED';
            errorDescription = `Failed to ${operation} VSCode proxy configuration: ${errorMessage}`;
        }
        // Check for configuration read failures
        else if (operation === 'get') {
            errorType = 'CONFIG_READ_FAILED';
            errorDescription = `Failed to read VSCode proxy configuration: ${errorMessage}`;
        }

        return {
            success: false,
            error: errorDescription,
            errorType
        };
    }
}
