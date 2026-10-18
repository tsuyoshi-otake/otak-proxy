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
import { canonicalizeValidProxyUrl, tryCanonicalizeProxyUrl } from '../utils/ProxyUtils';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';
import {
    getProxyPublicUrl,
    hasProxyCredentials,
    removeProxyCredentials,
    setRequiresAuthFromLiveUrls
} from '../utils/ProxyStateSanitizer';
import { I18nManager } from '../i18n/I18nManager';
import { ProxyState } from '../core/types';

export async function showInvalidProxyUrl(ctx: CommandContext, proxyUrl: string, i18n: I18nManager): Promise<void> {
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
    // Recompute the credential bookkeeping from the URLs actually present so
    // replacing or dropping a credential-bearing address cannot leave a stale
    // requiresAuth/authRequiredProxyUrls behind (#108).
    setRequiresAuthFromLiveUrls(state);
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
    // Store and apply the canonical form (#108): a URL the validator accepts
    // in a non-canonical spelling (trailing slash, upper-case scheme, literal
    // `%` in credentials) must reach every downstream consumer canonicalized.
    let canonicalUrl = '';
    if (proxyUrl) {
        const canonical = canonicalizeValidProxyUrl(proxyUrl);
        if (!canonical) {
            await showInvalidProxyUrl(ctx, proxyUrl, i18n);
            return { success: false };
        }
        canonicalUrl = canonical;
    }

    // Resubmitting the credential-free URL of a stored credential-bearing URL
    // (the prefill the command shows) keeps the stored credentials: removing
    // them requires entering different credentials or a different URL (#108).
    const storedUrl = state.manualProxyUrl;
    if (
        canonicalUrl &&
        storedUrl &&
        !hasProxyCredentials(canonicalUrl) &&
        hasProxyCredentials(storedUrl) &&
        getProxyPublicUrl(canonicalUrl) === getProxyPublicUrl(storedUrl)
    ) {
        canonicalUrl = storedUrl;
    }

    await saveManualProxyUrl(ctx, state, canonicalUrl);
    await applyManualModeChange(ctx, state, canonicalUrl);
    return { success: true };
}

function manualProxyPrefillValue(manualProxyUrl: string | undefined): string {
    if (!manualProxyUrl) {
        return '';
    }
    const publicUrl = getProxyPublicUrl(manualProxyUrl);
    // getProxyPublicUrl returns a WHATWG href with a trailing `/`; show the
    // canonical spelling instead so the prefill matches what a valid entry
    // would be stored as. A stored value that is not a valid proxy URL
    // prefills empty — the hydrated string is never returned raw, because it
    // could carry SecretStorage credentials. The quiet form is used because
    // opening the prompt is not a rejection to log (#108).
    return (publicUrl ? tryCanonicalizeProxyUrl(publicUrl) : undefined) ?? '';
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
            // The stored URL may be hydrated with SecretStorage credentials;
            // prefill the credential-free canonical form so the password is
            // never shown in clear (#108).
            value: manualProxyPrefillValue(state.manualProxyUrl)
        });

        if (proxyUrl === undefined) {
            return { success: true };
        }

        return await handleProxyUrlInput(ctx, state, proxyUrl, i18n);
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
