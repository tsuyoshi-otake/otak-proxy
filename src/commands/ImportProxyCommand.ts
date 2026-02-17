/**
 * @file ImportProxyCommand
 * @description Import system proxy settings command
 *
 * Requirements:
 * - 1.1: Concise error messages with details in output channel
 * - 3.3: Log detailed information to output channel
 * - 6.3: Action buttons for manual setup and redetect
 */

import * as vscode from 'vscode';
import { ProxyMode, type ProxyState } from '../core/types';
import { validateProxyUrl, sanitizeProxyUrl, testProxyConnection, detectSystemProxySettings } from '../utils/ProxyUtils';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';

/**
 * Execute the import proxy command
 * Detects system proxy and offers options to use it
 *
 * @param ctx - Command execution context
 * @returns CommandResult indicating success or failure
 */
export async function executeImportProxy(ctx: CommandContext): Promise<CommandResult> {
    try {
        const i18n = I18nManager.getInstance();
        
        const detectedProxy = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: i18n.t('message.detectingSystemProxy'),
            cancellable: false
        }, async () => {
            return await detectSystemProxySettings();
        });

        const state = await ctx.getProxyState();

        if (detectedProxy) {
            // Requirement 2.3: Display sanitized proxy URL to user
            const sanitizedProxy = ctx.sanitizer.maskPassword(detectedProxy);
            const action = await vscode.window.showInformationMessage(
                i18n.t('prompt.foundSystemProxy', { url: sanitizedProxy }),
                i18n.t('action.useAutoMode'),
                i18n.t('action.testFirst'),
                i18n.t('action.saveAsManual'),
                i18n.t('action.cancel')
            );

            if (action === i18n.t('action.testFirst')) {
                return await handleTestFirst(ctx, state, detectedProxy, i18n);
            } else if (action === i18n.t('action.useAutoMode')) {
                return await handleUseAutoMode(ctx, state, detectedProxy);
            } else if (action === i18n.t('action.saveAsManual')) {
                return await handleSaveAsManual(ctx, state, detectedProxy);
            }
        } else {
            // Requirement 6.3: Show action buttons for manual setup and redetect
            const action = await vscode.window.showWarningMessage(
                i18n.t('warning.noSystemProxyCheck'),
                i18n.t('action.configureManual'),
                i18n.t('action.redetect')
            );

            if (action === i18n.t('action.configureManual')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            } else if (action === i18n.t('action.redetect')) {
                // Recursively call import proxy again
                return await executeImportProxy(ctx);
            }
        }

        return { success: true };
    } catch (error) {
        Logger.error('Import proxy command failed:', error);
        
        // Requirement 1.1, 3.3: Log detailed error to output channel
        const outputManager = OutputChannelManager.getInstance();
        outputManager.logError('Import proxy command failed', {
            timestamp: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
            stackTrace: error instanceof Error ? error.stack : undefined
        });
        
        ctx.userNotifier.showError(
            'error.importProxyFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}

/**
 * Handle "Test First" action
 */
async function handleTestFirst(
    ctx: CommandContext,
    state: ProxyState,
    detectedProxy: string,
    i18n: I18nManager
): Promise<CommandResult> {
    const testResult = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: i18n.t('message.testingProxyGeneric'),
        cancellable: false
    }, async () => {
        return await testProxyConnection(detectedProxy);
    });

    if (testResult.success) {
        const useAction = await vscode.window.showInformationMessage(
            i18n.t('prompt.proxyWorks'),
            i18n.t('action.useAutoMode'),
            i18n.t('action.saveAsManual'),
            i18n.t('action.cancel')
        );

        if (useAction === i18n.t('action.useAutoMode')) {
            return await handleUseAutoMode(ctx, state, detectedProxy);
        } else if (useAction === i18n.t('action.saveAsManual')) {
            return await handleSaveAsManual(ctx, state, detectedProxy);
        }
    } else {
        // Requirement 1.1, 3.3: Use showErrorWithDetails for concise notification with detailed logging
        const errorDetails = {
            timestamp: new Date(),
            errorMessage: i18n.t('error.proxyDoesNotWork'),
            attemptedUrls: testResult.testUrls,
            context: testResult.errors ? {
                errors: testResult.errors.map(err => `${err.url}: ${err.message}`)
            } : undefined
        };

        await ctx.userNotifier.showErrorWithDetails(
            'error.proxyDoesNotWork',
            errorDetails,
            [
                'suggestion.verifyServerRunning',
                'suggestion.checkConnectivity',
                'suggestion.tryDifferentConfig'
            ]
        );
    }

    return { success: true };
}

/**
 * Handle "Use Auto Mode" action
 */
async function handleUseAutoMode(
    ctx: CommandContext,
    state: ProxyState,
    detectedProxy: string
): Promise<CommandResult> {
    if (validateProxyUrl(detectedProxy)) {
        state.autoProxyUrl = detectedProxy;
        state.mode = ProxyMode.Auto;
        await ctx.saveProxyState(state);
        await ctx.applyProxySettings(detectedProxy, true);
        ctx.updateStatusBar(state);
        await ctx.startSystemProxyMonitoring();
        ctx.userNotifier.showSuccess('message.switchedToAutoMode', {
            url: sanitizeProxyUrl(detectedProxy)
        });
    } else {
        showInvalidProxyError(ctx);
    }

    return { success: true };
}

/**
 * Handle "Save as Manual" action
 */
async function handleSaveAsManual(
    ctx: CommandContext,
    state: ProxyState,
    detectedProxy: string
): Promise<CommandResult> {
    if (validateProxyUrl(detectedProxy)) {
        state.manualProxyUrl = detectedProxy;
        await ctx.saveProxyState(state);
        await vscode.workspace.getConfiguration('otakProxy').update(
            'proxyUrl',
            detectedProxy,
            vscode.ConfigurationTarget.Global
        );
        ctx.updateStatusBar(state);
        ctx.userNotifier.showSuccess('message.savedAsManualProxy', {
            url: sanitizeProxyUrl(detectedProxy)
        });
    } else {
        showInvalidProxyError(ctx);
    }

    return { success: true };
}

/**
 * Show invalid proxy URL error
 */
function showInvalidProxyError(ctx: CommandContext): void {
    ctx.userNotifier.showError(
        'error.invalidProxyUrlDetected',
        [
            'suggestion.invalidFormatDetected',
            'suggestion.checkSystemSettings',
            'suggestion.configureManualInstead'
        ]
    );
}
