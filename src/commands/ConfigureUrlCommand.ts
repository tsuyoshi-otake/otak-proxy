/**
 * @file ConfigureUrlCommand
 * @description Manual proxy URL configuration command
 *
 * Requirements:
 * - 1.4: Error handling for command execution
 * - 2.1: Configure manual proxy URL
 * - 4.4: Graceful error handling
 */

import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';
import { validateProxyUrl } from '../utils/ProxyUtils';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';

/**
 * Execute the configure URL command
 * Prompts user to enter a manual proxy URL and saves it
 *
 * @param ctx - Command execution context
 * @returns CommandResult indicating success or failure
 */
export async function executeConfigureUrl(ctx: CommandContext): Promise<CommandResult> {
    try {
        const state = await ctx.getProxyState();
        const proxyUrl = await vscode.window.showInputBox({
            prompt: 'Enter proxy URL (e.g., http://proxy.example.com:8080)',
            placeHolder: 'http://proxy.example.com:8080',
            value: state.manualProxyUrl || ''
        });

        if (proxyUrl !== undefined) {
            if (proxyUrl && !validateProxyUrl(proxyUrl)) {
                ctx.userNotifier.showError(
                    'Invalid proxy URL format',
                    [
                        'Use format: http://proxy.example.com:8080',
                        'Include protocol (http:// or https://)',
                        'Ensure hostname contains only alphanumeric characters, dots, and hyphens'
                    ]
                );
                return { success: false };
            }

            // Save manual proxy URL
            state.manualProxyUrl = proxyUrl;
            await ctx.saveProxyState(state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update(
                'proxyUrl',
                proxyUrl,
                vscode.ConfigurationTarget.Global
            );

            // If currently in manual mode, apply the new settings
            if (state.mode === ProxyMode.Manual) {
                if (proxyUrl) {
                    await ctx.applyProxySettings(proxyUrl, true);
                } else {
                    // Manual proxy was removed, switch to Off
                    state.mode = ProxyMode.Off;
                    await ctx.saveProxyState(state);
                    await ctx.applyProxySettings('', false);
                }
                ctx.updateStatusBar(state);
            }
        }

        return { success: true };
    } catch (error) {
        Logger.error('Configure URL command failed:', error);
        ctx.userNotifier.showError(
            'Failed to configure proxy URL',
            ['Check the output log for details', 'Try reloading the window']
        );
        return { success: false, error: error as Error };
    }
}
