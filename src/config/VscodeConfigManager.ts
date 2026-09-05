import * as vscode from 'vscode';
import { Logger } from '../utils/Logger';
import { getErrorMessage } from '../utils/ErrorUtils';
import { ProxyConfigInspection } from './ProxyConfigInspection';
import { compareThenDelete, UNSET_UNREADABLE } from './ValueAwareUnset';

/**
 * Result of a VSCode configuration operation
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'CONFIG_WRITE_FAILED' | 'CONFIG_READ_FAILED' | 'UNKNOWN';
    preservedKeys?: readonly string[];
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
    /**
     * Removes VSCode global proxy configuration.
     * When `options.expectedValue` is provided, compare/delete + post-read: a
     * different current value is preserved. The VS Code API has no compare-and-swap.
     *
     * Non-guarantee: `config.update` is last-write-wins. An external writer
     * during that update can still be overwritten.
     */
    async unsetProxy(options?: { expectedValue?: string }): Promise<OperationResult> {
        try {
            const expectedValue = options?.expectedValue;
            if (expectedValue !== undefined) {
                const outcome = await compareThenDelete({
                    expected: expectedValue,
                    read: async () => {
                        const inspection = await this.inspectProxy();
                        if (inspection.status !== 'available') {
                            return UNSET_UNREADABLE;
                        }
                        return inspection.values?.proxy ?? null;
                    },
                    deleteKey: async () => {
                        const config = vscode.workspace.getConfiguration('http');
                        await config.update('proxy', '', vscode.ConfigurationTarget.Global);
                    }
                });
                if (!outcome.ok) {
                    return this.handleError(
                        new Error(
                            outcome.reason === 'unreadable'
                                ? 'VS Code proxy re-read failed; refusing to unset'
                                : 'VS Code owned proxy value remained after unset'
                        ),
                        outcome.reason === 'unreadable' ? 'get' : 'unset'
                    );
                }
                return outcome.preserved
                    ? { success: true, preservedKeys: ['http.proxy'] }
                    : { success: true };
            }

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
        const inspection = await this.inspectProxy();
        return inspection.status === 'available' ? inspection.values?.proxy ?? null : null;
    }

    async inspectProxy(): Promise<ProxyConfigInspection<{ proxy: string | null }>> {
        try {
            const config = vscode.workspace.getConfiguration('http');
            const proxy = config.get<string>('proxy');

            return {
                status: 'available',
                values: { proxy: proxy && proxy.trim() !== '' ? proxy : null }
            };
        } catch (error) {
            Logger.error('Error getting VSCode proxy:', error);
            const failure = this.handleError(error, 'get');
            return {
                status: 'error',
                error: failure.error,
                errorType: failure.errorType
            };
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
