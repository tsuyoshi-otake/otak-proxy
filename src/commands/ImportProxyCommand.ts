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
import { ProxyMode, type AppliedProxySource, type ProxyState } from '../core/types';
import { isUnsupportedAutoConfig } from '../config/SystemProxyDetector';
import { unsupportedAutoConfigKindLabel } from '../diagnostics/unsupportedAutoConfig';
import { validateProxyUrl, sanitizeProxyUrl, testProxyConnection, detectSystemProxySettingsWithSource } from '../utils/ProxyUtils';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';
import { removeProxyCredentials, setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';
import { assignDetectedProxyToState } from '../config/DetectedProxyValue';
import type { ProxyDetectionWithSource } from '../config/SystemProxyDetector';
import { diffProxyState } from '../core/ApplyConvergence';
import { commitCommandPatch } from './CommandStateCommit';

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
        
        const detected = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: i18n.t('message.detectingSystemProxy'),
            cancellable: false
        }, async () => {
            return await detectSystemProxySettingsWithSource();
        });
        const detectedProxy = detected.proxyUrl;
        const detectedSource: AppliedProxySource | undefined = detected.source ?? undefined;

        if (isUnsupportedAutoConfig(detected)) {
            const action = await vscode.window.showWarningMessage(
                i18n.t('warning.unsupportedAutoConfig', {
                    kind: unsupportedAutoConfigKindLabel(detected.kind)
                }),
                i18n.t('action.configureManual'),
                i18n.t('action.redetect')
            );

            if (action === i18n.t('action.configureManual')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            } else if (action === i18n.t('action.redetect')) {
                return await executeImportProxy(ctx);
            }

            return { success: true };
        }

        if (detected.kind === 'unknown') {
            const action = await vscode.window.showWarningMessage(
                i18n.t('warning.detectionFailed'),
                i18n.t('action.configureManual'),
                i18n.t('action.redetect')
            );

            if (action === i18n.t('action.configureManual')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            } else if (action === i18n.t('action.redetect')) {
                return await executeImportProxy(ctx);
            }

            return { success: true };
        }

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
                return await handleTestFirst(ctx, detected, detectedSource, i18n);
            } else if (action === i18n.t('action.useAutoMode')) {
                return await handleUseAutoMode(ctx, detected, detectedSource);
            } else if (action === i18n.t('action.saveAsManual')) {
                return await handleSaveAsManual(ctx, detectedProxy);
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
    detected: ProxyDetectionWithSource,
    detectedSource: AppliedProxySource | undefined,
    i18n: I18nManager
): Promise<CommandResult> {
    const detectedProxy = detected.proxyUrl!;
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
            return await handleUseAutoMode(ctx, detected, detectedSource);
        } else if (useAction === i18n.t('action.saveAsManual')) {
            return await handleSaveAsManual(ctx, detectedProxy);
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
 * The fields "Use Auto Mode" decides, set on `state`.
 */
function useDetectedProxyAsAuto(
    state: ProxyState,
    detected: ProxyDetectionWithSource,
    detectedSource: AppliedProxySource | undefined
): void {
    assignDetectedProxyToState(state, detected);
    state.mode = ProxyMode.Auto;
    state.autoModeOff = false;
    state.usingFallbackProxy = false;
    state.fallbackProxyUrl = undefined;
    if (detectedSource) {
        state.lastDetectionSource = detectedSource;
    }
    state.proxyReachable = undefined;
    state.lastTestResult = undefined;
    state.lastTestTimestamp = undefined;
    state.systemProxyDetected = true;
    setRequiresAuthFromLiveUrls(state);
}

/**
 * Handle "Use Auto Mode" action. The choice is explicit, so it also wins over a
 * toggle that landed while the notification was open; every other field is
 * whatever was committed last, not the copy read before the prompt (#135).
 */
async function handleUseAutoMode(
    ctx: CommandContext,
    detected: ProxyDetectionWithSource,
    detectedSource: AppliedProxySource | undefined
): Promise<CommandResult> {
    const detectedProxy = detected.proxyUrl!;
    if (validateProxyUrl(detectedProxy)) {
        // Set by the fold of the attempt that committed: the monitor restarts
        // only when the state it replaced was Auto.
        const folded = { wasAutoMode: false };
        await commitCommandPatch(ctx, latest => {
            folded.wasAutoMode = latest.mode === ProxyMode.Auto;
            const decided: ProxyState = { ...latest };
            useDetectedProxyAsAuto(decided, detected, detectedSource);
            return diffProxyState(latest, decided);
        });
        const applied = await ctx.applyProxySettings(detectedProxy, true);
        ctx.updateStatusBar(await ctx.getProxyState());
        if (folded.wasAutoMode) {
            await ctx.stopSystemProxyMonitoring();
        }
        await ctx.startSystemProxyMonitoring();
        if (applied) {
            ctx.userNotifier.showSuccess('message.switchedToAutoMode', {
                url: sanitizeProxyUrl(detectedProxy)
            });
        }
    } else {
        showInvalidProxyError(ctx);
    }

    return { success: true };
}

/**
 * Handle "Save as Manual" action. Only the manual URL is decided: the mode and
 * everything else stay as committed meanwhile, so a toggle to Off that landed
 * while the notification was open is not rolled back (#135).
 */
async function handleSaveAsManual(
    ctx: CommandContext,
    detectedProxy: string
): Promise<CommandResult> {
    if (validateProxyUrl(detectedProxy)) {
        await commitCommandPatch(ctx, { manualProxyUrl: detectedProxy });
        await vscode.workspace.getConfiguration('otakProxy').update(
            'proxyUrl',
            removeProxyCredentials(detectedProxy) || detectedProxy,
            vscode.ConfigurationTarget.Global
        );
        ctx.updateStatusBar(await ctx.getProxyState());
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
