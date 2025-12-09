/**
 * @file TestProxyCommand
 * @description Test proxy connection command
 *
 * Requirements:
 * - 1.1: Concise error messages with details in output channel
 * - 1.3: Summarize URL lists in notifications
 * - 3.3, 3.4: Log detailed information to output channel
 * - 4.1, 4.2, 4.3: Show progress notifications during testing
 * - 6.2: Action buttons for retest and change settings
 */

import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';
import { testProxyConnection } from '../utils/ProxyUtils';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';

/**
 * Execute the test proxy command
 * Tests the current proxy connection and reports results
 *
 * @param ctx - Command execution context
 * @returns CommandResult indicating success or failure
 */
export async function executeTestProxy(ctx: CommandContext): Promise<CommandResult> {
    try {
        const state = await ctx.getProxyState();
        const activeUrl = ctx.getActiveProxyUrl(state);
        const i18n = I18nManager.getInstance();
        const outputManager = OutputChannelManager.getInstance();

        if (!activeUrl) {
            // Requirement 3.1, 3.2: Show error with action buttons
            const action = await vscode.window.showErrorMessage(
                i18n.t('message.noProxyConfigured', { mode: state.mode.toUpperCase() }),
                i18n.t('action.configureManual'),
                i18n.t('action.importSystem'),
                i18n.t('action.cancel')
            );

            if (action === i18n.t('action.configureManual')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            } else if (action === i18n.t('action.importSystem')) {
                await vscode.commands.executeCommand('otak-proxy.importProxy');
            }
            return { success: true };
        }

        // Requirement 1.5, 6.2: Use sanitized URL for display
        const sanitizedUrl = ctx.sanitizer.maskPassword(activeUrl);

        // Requirement 4.1, 4.2, 4.3: Show progress notification with URL count
        const testResult = await ctx.userNotifier.showProgressNotification(
            i18n.t('message.testingProxy', { mode: state.mode, url: sanitizedUrl }),
            async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
                // Report progress for each test URL
                const result = await testProxyConnection(activeUrl);
                
                if (result.testUrls && result.testUrls.length > 0) {
                    for (let i = 0; i < result.testUrls.length; i++) {
                        progress.report({
                            message: `Testing ${i + 1}/${result.testUrls.length}: ${result.testUrls[i]}`,
                            increment: (100 / result.testUrls.length)
                        });
                        // Small delay to show progress
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                
                return result;
            },
            false
        );

        if (testResult.success) {
            ctx.userNotifier.showSuccess('message.proxyWorks', {
                mode: state.mode.toUpperCase(),
                url: sanitizedUrl
            });
        } else {
            // Requirement 2.4: Provide troubleshooting suggestions
            const suggestions = [
                i18n.t('suggestion.verifyUrl'),
                i18n.t('suggestion.checkServer'),
                i18n.t('suggestion.checkNetwork'),
                i18n.t('suggestion.checkFirewall'),
                state.mode === ProxyMode.Manual
                    ? i18n.t('suggestion.reconfigureManual')
                    : i18n.t('suggestion.checkSystemSettings'),
                i18n.t('suggestion.testDifferentApp')
            ];

            // Requirement 1.1, 3.3, 3.4: Use showErrorWithDetails for concise notification with detailed logging
            const errorDetails = {
                timestamp: new Date(),
                errorMessage: i18n.t('error.proxyTestFailed', { url: sanitizedUrl }),
                attemptedUrls: testResult.testUrls,
                context: testResult.errors ? {
                    errors: testResult.errors.map((err: any) => `${err.url}: ${err.message}`)
                } : undefined
            };

            await ctx.userNotifier.showErrorWithDetails(
                'error.proxyTestFailed',
                errorDetails,
                suggestions,
                { url: sanitizedUrl }
            );

            // Requirement 6.2: Show action buttons for retest and change settings
            const action = await vscode.window.showErrorMessage(
                i18n.t('error.proxyTestFailed', { url: sanitizedUrl }),
                i18n.t('action.retest'),
                i18n.t('action.changeSettings')
            );

            if (action === i18n.t('action.retest')) {
                // Recursively call test proxy again
                return await executeTestProxy(ctx);
            } else if (action === i18n.t('action.changeSettings')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            }
        }

        return { success: true };
    } catch (error) {
        Logger.error('Test proxy command failed:', error);
        
        // Log detailed error to output channel
        const outputManager = OutputChannelManager.getInstance();
        outputManager.logError('Test proxy command failed', {
            timestamp: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
            stackTrace: error instanceof Error ? error.stack : undefined
        });
        
        ctx.userNotifier.showError(
            'error.testProxyFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}
