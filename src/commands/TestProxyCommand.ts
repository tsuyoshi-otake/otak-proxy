/**
 * @file TestProxyCommand
 * @description Test proxy connection command
 *
 * Requirements:
 * - 1.4: Error handling for command execution
 * - 2.4: Enhanced with comprehensive error reporting
 * - 3.1, 3.2: Action buttons when no proxy configured
 */

import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';
import { testProxyConnection } from '../utils/ProxyUtils';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';

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

        const testResult = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: i18n.t('message.testingProxy', { mode: state.mode, url: sanitizedUrl }),
            cancellable: false
        }, async () => {
            return await testProxyConnection(activeUrl);
        });

        if (testResult.success) {
            ctx.userNotifier.showSuccess('message.proxyWorks', {
                mode: state.mode.toUpperCase(),
                url: sanitizedUrl
            });
        } else {
            // Requirement 2.4: Display attempted URLs in error messages
            const attemptedUrlsList = testResult.testUrls.map(url => `  • ${url}`).join('\n');

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

            // Build comprehensive error message with attempted URLs
            let errorMessage = i18n.t('error.proxyTestFailed', { url: sanitizedUrl }) +
                `\n\n${i18n.t('error.attemptedUrls')}\n${attemptedUrlsList}`;

            // Add specific error details if available
            if (testResult.errors && testResult.errors.length > 0) {
                const formattedErrors = testResult.errors
                    .map(err => `  - ${err.url}: ${err.message}`)
                    .join('\n');
                errorMessage += `\n\nErrors:\n${formattedErrors}`;
            }

            // Use UserNotifier for consistent error display
            ctx.userNotifier.showError(errorMessage, suggestions);
        }

        return { success: true };
    } catch (error) {
        Logger.error('Test proxy command failed:', error);
        ctx.userNotifier.showError(
            'error.testProxyFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}
