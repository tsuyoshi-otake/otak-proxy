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

let toggleQueue: Promise<void> = Promise.resolve();

// Guards against stacking duplicate prompts while a prior one is still
// unanswered (e.g. the user toggles repeatedly without dismissing the
// notification).
let manualProxyMissingPromptInFlight = false;
let systemProxySetupPromptInFlight = false;

/**
 * Fire a follow-up prompt/action without blocking the toggle queue. The
 * caller must have already finalized and applied the state transition, so a
 * slow or never-answered notification can no longer starve later toggles.
 * Mirrors ProxyRemediationService.notifyAfterApply (see CHANGELOG 3.1.3).
 */
function notifyAfterApply(task: () => Promise<void>): void {
    void task().catch(error => {
        Logger.warn('Toggle proxy notification failed:', error);
    });
}

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

async function promptForManualProxy(i18n: I18nManager): Promise<'configure' | 'skipToAuto' | 'cancel'> {
    const answer = await vscode.window.showInformationMessage(
        i18n.t('prompt.noManualProxy'),
        i18n.t('action.configureManual'),
        i18n.t('action.skipToAuto')
    );

    if (answer === i18n.t('action.configureManual')) {
        return 'configure';
    }

    if (answer === i18n.t('action.skipToAuto')) {
        return 'skipToAuto';
    }

    return 'cancel';
}

/**
 * No manual proxy URL is configured. There's nothing to switch into, so
 * redirect to Auto OFF immediately (releasing the toggle queue) and show the
 * "configure now?" prompt as a detached follow-up notification.
 *
 * NOTE: currently unreachable via the Off<->Auto toggle cycle
 * (ProxyStateManager.getNextMode never returns ProxyMode.Manual). Kept fixed
 * defensively for any future caller that targets Manual mode directly.
 */
function handleManualProxyMissing(state: ProxyState, i18n: I18nManager): void {
    state.mode = ProxyMode.Auto;
    state.autoModeOff = true;

    if (manualProxyMissingPromptInFlight) {
        return;
    }
    manualProxyMissingPromptInFlight = true;

    notifyAfterApply(async () => {
        try {
            const answer = await promptForManualProxy(i18n);
            if (answer === 'configure') {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            }
            // 'skipToAuto' / 'cancel': already redirected to Auto above; no-op.
        } finally {
            manualProxyMissingPromptInFlight = false;
        }
    });
}

async function applyReachableFallbackProxy(ctx: CommandContext, state: ProxyState, manualProxyUrl: string): Promise<void> {
    state.mode = ProxyMode.Auto;
    state.autoModeOff = false;
    state.usingFallbackProxy = true;
    state.fallbackProxyUrl = manualProxyUrl;
    state.autoProxyUrl = manualProxyUrl;

    const sanitizedManualProxyUrl = ctx.sanitizer.maskPassword(manualProxyUrl);
    Logger.log(`Fallback to Manual Proxy: ${sanitizedManualProxyUrl}`);
    ctx.userNotifier.showSuccess('fallback.usingManualProxy', { url: sanitizedManualProxyUrl });
}

async function tryApplyManualFallback(ctx: CommandContext, state: ProxyState): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('otakProxy');
    const fallbackEnabled = config.get<boolean>('enableFallback', true);
    const manualProxyUrl = state.manualProxyUrl;

    if (!fallbackEnabled || !manualProxyUrl) {
        return false;
    }

    const testResult = await testFallbackProxy(manualProxyUrl);
    state.lastTestResult = testResult;
    state.proxyReachable = testResult.success;
    state.lastTestTimestamp = Date.now();

    if (testResult.success) {
        await applyReachableFallbackProxy(ctx, state, manualProxyUrl);
        return true;
    }

    Logger.warn(`Fallback proxy is not reachable: ${ctx.sanitizer.maskPassword(manualProxyUrl)}`);
    setAutoModeOff(state);
    return false;
}

async function promptForSystemProxySetup(i18n: I18nManager): Promise<'configure' | 'import' | 'cancel'> {
    const action = await vscode.window.showWarningMessage(
        i18n.t('warning.noSystemProxyDetected'),
        i18n.t('action.configureManual'),
        i18n.t('action.importSystem')
    );

    if (action === i18n.t('action.configureManual')) {
        return 'configure';
    }

    if (action === i18n.t('action.importSystem')) {
        return 'import';
    }

    return 'cancel';
}

/**
 * No system proxy detected and no usable manual fallback. Apply Auto OFF
 * synchronously so the toggle queue releases immediately, then show the
 * warning as a detached follow-up notification. Its buttons run
 * configureUrl/importProxy directly - both commands re-read fresh state
 * themselves, so this is safe even if further toggles happen before the
 * user answers.
 */
function handleSystemProxySetupPrompt(state: ProxyState, i18n: I18nManager): void {
    setAutoModeOff(state);

    if (systemProxySetupPromptInFlight) {
        return;
    }
    systemProxySetupPromptInFlight = true;

    notifyAfterApply(async () => {
        try {
            const action = await promptForSystemProxySetup(i18n);
            if (action === 'configure') {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            } else if (action === 'import') {
                await vscode.commands.executeCommand('otak-proxy.importProxy');
            }
            // 'cancel'/dismissed: Auto OFF already applied above; nothing more to do.
        } finally {
            systemProxySetupPromptInFlight = false;
        }
    });
}

function useDetectedAutoProxy(state: ProxyState, nextMode: ProxyMode): void {
    state.mode = nextMode;
    state.autoModeOff = false;
    state.usingFallbackProxy = false;
    state.fallbackProxyUrl = undefined;
}

async function handleAutoModeTransition(
    ctx: CommandContext,
    state: ProxyState,
    nextMode: ProxyMode,
    i18n: I18nManager
): Promise<void> {
    await ctx.checkAndUpdateSystemProxy();
    const updatedState = await ctx.getProxyState();
    copyDetectedProxyState(state, updatedState);

    if (state.autoProxyUrl) {
        useDetectedAutoProxy(state, nextMode);
        return;
    }

    if (await tryApplyManualFallback(ctx, state)) {
        return;
    }

    handleSystemProxySetupPrompt(state, i18n);
}

async function prepareNextMode(
    ctx: CommandContext,
    state: ProxyState,
    nextMode: ProxyMode,
    i18n: I18nManager
): Promise<void> {
    if (nextMode === ProxyMode.Manual && !state.manualProxyUrl) {
        handleManualProxyMissing(state, i18n);
        return;
    }

    if (nextMode === ProxyMode.Auto && !state.autoProxyUrl) {
        await handleAutoModeTransition(ctx, state, nextMode, i18n);
        return;
    }

    state.mode = nextMode;
}

async function applyPreparedState(ctx: CommandContext, state: ProxyState): Promise<void> {
    await ctx.saveProxyState(state);
    const newActiveUrl = ctx.getActiveProxyUrl(state);

    ctx.updateStatusBar(state);
    await ctx.applyProxySettings(newActiveUrl, state.mode !== ProxyMode.Off && Boolean(newActiveUrl));

    if (state.mode === ProxyMode.Auto) {
        await ctx.startSystemProxyMonitoring();
    } else {
        await ctx.stopSystemProxyMonitoring();
    }
}

/**
 * Execute the toggle proxy command
 * Cycles through Off -> Auto -> Off modes.
 * Legacy Manual states are normalized to Auto by ProxyStateManager.getNextMode().
 *
 * @param ctx - Command execution context
 * @returns CommandResult indicating success or failure
 */
async function executeToggleProxyOnce(ctx: CommandContext): Promise<CommandResult> {
    try {
        const currentState = await ctx.getProxyState();
        const nextMode = ctx.getNextMode(currentState.mode);
        const i18n = I18nManager.getInstance();

        await prepareNextMode(ctx, currentState, nextMode, i18n);
        await applyPreparedState(ctx, currentState);

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

export function executeToggleProxy(ctx: CommandContext): Promise<CommandResult> {
    const queuedResult = toggleQueue.then(
        () => executeToggleProxyOnce(ctx),
        () => executeToggleProxyOnce(ctx)
    );

    // Keep rapid command invocations from reading and applying stale state in parallel.
    toggleQueue = queuedResult.then(() => undefined, () => undefined);
    return queuedResult;
}
