/**
 * @file ToggleProxyCommand
 * @description Toggle proxy mode command implementation
 *
 * Requirements:
 * - 1.4: Error handling for command execution
 * - 2.1: Cycle through Off -> Manual -> Auto -> Off
 * - 4.4: Graceful error handling
 */

import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';

/**
 * Execute the toggle proxy command
 * Cycles through Off -> Manual -> Auto -> Off modes
 *
 * @param ctx - Command execution context
 * @returns CommandResult indicating success or failure
 */
export async function executeToggleProxy(ctx: CommandContext): Promise<CommandResult> {
    try {
        const currentState = await ctx.getProxyState();
        const nextMode = ctx.getNextMode(currentState.mode);
        const i18n = I18nManager.getInstance();

        if (nextMode === ProxyMode.Manual && !currentState.manualProxyUrl) {
            // No manual proxy configured, prompt for setup
            const answer = await vscode.window.showInformationMessage(
                i18n.t('prompt.noManualProxy'),
                i18n.t('action.yes'),
                i18n.t('action.skipToAuto')
            );

            if (answer === i18n.t('action.yes')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
                return { success: true };
            } else if (answer === i18n.t('action.skipToAuto')) {
                currentState.mode = ProxyMode.Auto;
            } else {
                return { success: true }; // User cancelled
            }
        } else if (nextMode === ProxyMode.Auto && !currentState.autoProxyUrl) {
            // No system proxy detected, check now
            await ctx.checkAndUpdateSystemProxy();
            const updatedState = await ctx.getProxyState();

            if (!updatedState.autoProxyUrl) {
                // Show notification and automatically switch to Off mode
                ctx.userNotifier.showWarning('warning.noSystemProxyDetected');
                currentState.mode = ProxyMode.Off;
            } else {
                currentState.mode = nextMode as ProxyMode;
            }
        } else {
            currentState.mode = nextMode as ProxyMode;
        }

        // Apply the new mode
        await ctx.saveProxyState(currentState);
        const newActiveUrl = ctx.getActiveProxyUrl(currentState);
        await ctx.applyProxySettings(newActiveUrl, currentState.mode !== ProxyMode.Off);
        ctx.updateStatusBar(currentState);

        // Start or stop monitoring based on mode
        if (currentState.mode === ProxyMode.Auto) {
            await ctx.startSystemProxyMonitoring();
        }

        return { success: true };
    } catch (error) {
        Logger.error('Toggle proxy command failed:', error);
        ctx.userNotifier.showError(
            'error.toggleFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}
