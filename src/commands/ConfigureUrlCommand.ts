/**
 * @file ConfigureUrlCommand
 * @description Manual proxy URL configuration command
 *
 * Requirements:
 * - 1.1: Concise error messages with details in output channel
 * - 3.3: Log detailed information to output channel
 */

import * as vscode from 'vscode';
import { ProxyMode } from '../core/types';
import { validateProxyUrl } from '../utils/ProxyUtils';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';
import { removeProxyCredentials } from '../utils/ProxyStateSanitizer';
import { I18nManager } from '../i18n/I18nManager';
import { ProxyState } from '../core/types';

async function showInvalidProxyUrl(ctx: CommandContext, proxyUrl: string, i18n: I18nManager): Promise<void> {
    const errorDetails = {
        timestamp: new Date(),
        errorMessage: i18n.t('error.invalidProxyUrl'),
        context: {
            providedUrl: ctx.sanitizer.maskPassword(proxyUrl)
        }
    };

    await ctx.userNotifier.showErrorWithDetails(
        'error.invalidProxyUrl',
        errorDetails,
        [
            'suggestion.useFormat',
            'suggestion.includeProtocol',
            'suggestion.validHostname'
        ]
    );
}

async function saveManualProxyUrl(ctx: CommandContext, state: ProxyState, proxyUrl: string): Promise<void> {
    state.manualProxyUrl = proxyUrl;
    await ctx.saveProxyState(state);

    await vscode.workspace.getConfiguration('otakProxy').update(
        'proxyUrl',
        removeProxyCredentials(proxyUrl) || proxyUrl,
        vscode.ConfigurationTarget.Global
    );
}

async function applyManualModeChange(ctx: CommandContext, state: ProxyState, proxyUrl: string): Promise<void> {
    if (state.mode !== ProxyMode.Manual) {
        return;
    }

    if (proxyUrl) {
        await ctx.applyProxySettings(proxyUrl, true);
    } else {
        state.mode = ProxyMode.Off;
        await ctx.saveProxyState(state);
        await ctx.applyProxySettings('', false);
    }

    ctx.updateStatusBar(state);
}

async function handleProxyUrlInput(
    ctx: CommandContext,
    state: ProxyState,
    proxyUrl: string,
    i18n: I18nManager
): Promise<CommandResult> {
    if (proxyUrl && !validateProxyUrl(proxyUrl)) {
        await showInvalidProxyUrl(ctx, proxyUrl, i18n);
        return { success: false };
    }

    await saveManualProxyUrl(ctx, state, proxyUrl);
    await applyManualModeChange(ctx, state, proxyUrl);
    return { success: true };
}

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
        const i18n = I18nManager.getInstance();
        const proxyUrl = await vscode.window.showInputBox({
            prompt: i18n.t('prompt.proxyUrl'),
            placeHolder: i18n.t('prompt.proxyUrlPlaceholder'),
            value: state.manualProxyUrl || ''
        });

        if (proxyUrl === undefined) {
            return { success: true };
        }

        return handleProxyUrlInput(ctx, state, proxyUrl, i18n);
    } catch (error) {
        Logger.error('Configure URL command failed:', error);
        
        // Requirement 1.1, 3.3: Log detailed error to output channel
        const outputManager = OutputChannelManager.getInstance();
        outputManager.logError('Configure URL command failed', {
            timestamp: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
            stackTrace: error instanceof Error ? error.stack : undefined
        });
        
        ctx.userNotifier.showError(
            'error.configureUrlFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}
