/**
 * @file ToggleProxyCommand
 * @description Toggle proxy mode command implementation
 *
 * Requirements:
 * - 1.1: Concise error messages with details in output channel
 * - 3.3: Log detailed information to output channel
 * - 6.1: Action buttons for manual setup and system import
 */

import * as vscode from 'vscode';
import { ProxyMode, type ProxyState, type ProxyTestResult } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import {
    getDefaultAutoTimeout,
    getDefaultTestUrls,
    testProxyConnectionParallel
} from '../utils/ProxyUtils';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';

function copyDetectedProxyState(target: ProxyState, source: ProxyState): void {
    target.autoProxyUrl = source.autoProxyUrl;
    target.lastSystemProxyCheck = source.lastSystemProxyCheck;
    target.systemProxyDetected = source.systemProxyDetected;
    target.lastSystemProxyUrl = source.lastSystemProxyUrl;
    target.lastTestResult = source.lastTestResult;
    target.proxyReachable = source.proxyReachable;
    target.lastTestTimestamp = source.lastTestTimestamp;
    target.usingFallbackProxy = source.usingFallbackProxy;
    target.fallbackProxyUrl = source.fallbackProxyUrl;
    target.autoModeOff = source.autoModeOff;
}

function setAutoModeOff(state: ProxyState): void {
    state.mode = ProxyMode.Auto;
    state.autoProxyUrl = undefined;
    state.autoModeOff = true;
    state.usingFallbackProxy = false;
    state.fallbackProxyUrl = undefined;
}

async function testFallbackProxy(proxyUrl: string): Promise<ProxyTestResult> {
    const testResult = await testProxyConnectionParallel(
        proxyUrl,
        getDefaultTestUrls(),
        getDefaultAutoTimeout()
    );
    return testResult as ProxyTestResult;
}

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
        const outputManager = OutputChannelManager.getInstance();

        if (nextMode === ProxyMode.Manual && !currentState.manualProxyUrl) {
            // Requirement 6.1: Show action buttons for manual setup
            const answer = await vscode.window.showInformationMessage(
                i18n.t('prompt.noManualProxy'),
                i18n.t('action.configureManual'),
                i18n.t('action.skipToAuto')
            );

            if (answer === i18n.t('action.configureManual')) {
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
            copyDetectedProxyState(currentState, updatedState);

            if (!currentState.autoProxyUrl) {
                // Check if fallback to manual proxy is available
                const config = vscode.workspace.getConfiguration('otakProxy');
                const fallbackEnabled = config.get<boolean>('enableFallback', true);
                const manualProxyUrl = currentState.manualProxyUrl;
                let shouldPromptForSetup = true;

                if (fallbackEnabled && manualProxyUrl) {
                    const testResult = await testFallbackProxy(manualProxyUrl);
                    currentState.lastTestResult = testResult;
                    currentState.proxyReachable = testResult.success;
                    currentState.lastTestTimestamp = Date.now();

                    if (testResult.success) {
                        // Use manual proxy as fallback - Fallback mode (NOT Auto Mode OFF)
                        currentState.mode = ProxyMode.Auto;
                        currentState.autoModeOff = false;
                        currentState.usingFallbackProxy = true;
                        currentState.fallbackProxyUrl = manualProxyUrl;
                        currentState.autoProxyUrl = manualProxyUrl; // Use fallback as active proxy

                        const sanitizedManualProxyUrl = ctx.sanitizer.maskPassword(manualProxyUrl);
                        Logger.log(`Fallback to Manual Proxy: ${sanitizedManualProxyUrl}`);
                        ctx.userNotifier.showSuccess('fallback.usingManualProxy', { url: sanitizedManualProxyUrl });
                        shouldPromptForSetup = false;
                    } else {
                        Logger.warn(`Fallback proxy is not reachable: ${ctx.sanitizer.maskPassword(manualProxyUrl)}`);
                        setAutoModeOff(currentState);
                    }
                }

                if (shouldPromptForSetup) {
                    // Requirement 6.1: Show action buttons for system import
                    const action = await vscode.window.showWarningMessage(
                        i18n.t('warning.noSystemProxyDetected'),
                        i18n.t('action.configureManual'),
                        i18n.t('action.importSystem')
                    );

                    if (action === i18n.t('action.configureManual')) {
                        await vscode.commands.executeCommand('otak-proxy.configureUrl');
                        return { success: true };
                    } else if (action === i18n.t('action.importSystem')) {
                        await vscode.commands.executeCommand('otak-proxy.importProxy');
                        return { success: true };
                    }

                    // No fallback available - set to Auto Mode OFF (not complete Off)
                    setAutoModeOff(currentState);
                }
            } else {
                currentState.mode = nextMode as ProxyMode;
                currentState.autoModeOff = false;
                currentState.usingFallbackProxy = false;
                currentState.fallbackProxyUrl = undefined;
            }
        } else {
            currentState.mode = nextMode as ProxyMode;
        }

        // Apply the new mode
        await ctx.saveProxyState(currentState);
        const newActiveUrl = ctx.getActiveProxyUrl(currentState);

        // Update the status bar immediately to reflect the user's action,
        // then apply settings in the background.
        ctx.updateStatusBar(currentState);
        await ctx.applyProxySettings(newActiveUrl, currentState.mode !== ProxyMode.Off && Boolean(newActiveUrl));

        // Start or stop monitoring based on mode
        if (currentState.mode === ProxyMode.Auto) {
            await ctx.startSystemProxyMonitoring();
        } else {
            await ctx.stopSystemProxyMonitoring();
        }

        return { success: true };
    } catch (error) {
        Logger.error('Toggle proxy command failed:', error);
        
        // Requirement 1.1, 3.3: Log detailed error to output channel
        const outputManager = OutputChannelManager.getInstance();
        outputManager.logError('Toggle proxy command failed', {
            timestamp: new Date(),
            errorMessage: error instanceof Error ? error.message : String(error),
            stackTrace: error instanceof Error ? error.stack : undefined
        });
        
        ctx.userNotifier.showError(
            'error.toggleFailed',
            ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
        );
        return { success: false, error: error as Error };
    }
}
