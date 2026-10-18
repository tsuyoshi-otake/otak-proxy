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
import { clearPendingThenPublish, ApplyConvergenceContext } from '../core/ApplyConvergence';
import { ProxyMode, stateRevision, type ProxyState, type ProxyTestResult } from '../core/types';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import {
    getDefaultAutoTimeout,
    getDefaultTestUrls,
    isProxyEndpointReachable,
    testProxyConnectionParallel
} from '../utils/ProxyUtils';
import { CommandContext, CommandResult } from './types';
import { OutputChannelManager } from '../errors/OutputChannelManager';
import { setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';

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
    target.lastDetectionSource = source.lastDetectionSource;
    target.requiresAuth = source.requiresAuth;
}

function setAutoModeOff(state: ProxyState): void {
    state.mode = ProxyMode.Auto;
    state.autoProxyUrl = undefined;
    state.autoModeOff = true;
    state.usingFallbackProxy = false;
    state.fallbackProxyUrl = undefined;
    state.lastDetectionSource = undefined;
    setRequiresAuthFromLiveUrls(state);
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
    state.lastDetectionSource = 'fallback';
    setRequiresAuthFromLiveUrls(state);

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
    state.proxyReachable = isProxyEndpointReachable(testResult);
    state.lastTestTimestamp = Date.now();

    if (isProxyEndpointReachable(testResult)) {
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

/**
 * Bound on desired-state commit retries. A same-mode writer that only moves
 * the revision or detection/test fields (monitor test results, apply results,
 * the startup apply) makes the compare-and-set fail; refolding onto the new
 * latest and retrying a few times absorbs that without dropping the toggle.
 */
const TOGGLE_COMMIT_MAX_ATTEMPTS = 3;

/**
 * Fields `prepareNextMode` changed between the pre-toggle snapshot and the
 * desired state. Only these are folded onto the latest state on each CAS
 * attempt: folding the whole snapshot would roll back fields other writers
 * own (fresh detection results, monitor test results, apply-result commits)
 * that landed between the snapshot and the commit (#78).
 */
function changedToggleFields(before: ProxyState, after: ProxyState): Partial<ProxyState> {
    const changed: Partial<ProxyState> = {};
    for (const key of Object.keys(after) as (keyof ProxyState)[]) {
        if (before[key] !== after[key]) {
            (changed as Record<keyof ProxyState, unknown>)[key] = after[key];
        }
    }
    return changed;
}

/**
 * Commits the desired mode with `convergencePending: true` before the apply,
 * without publishing. The toggle is superseded only when another writer
 * changed the saved mode (a sync toggle, another command): the fold then
 * returns undefined and the caller does not apply. Detection/test churn under
 * the same mode is folded onto the latest state and retried (#78).
 */
async function commitToggleDesiredState(
    ctx: CommandContext,
    desiredFields: Partial<ProxyState>,
    fromMode: ProxyMode
): Promise<ProxyState | undefined> {
    for (let attempt = 0; attempt < TOGGLE_COMMIT_MAX_ATTEMPTS; attempt++) {
        const latest = await ctx.getProxyState();
        if (latest.mode !== fromMode) {
            return undefined;
        }
        const next: ProxyState = {
            ...latest,
            ...desiredFields,
            revision: latest.revision,
            convergencePending: true
        };
        const result = await ctx.commitProxyState(stateRevision(latest), next);
        if (result.kind === 'committed') {
            return result.state;
        }
    }
    Logger.warn('Toggle proxy superseded: proxy state kept changing under the commit window.');
    return undefined;
}

function toggleConvergenceContext(ctx: CommandContext): ApplyConvergenceContext {
    return {
        proxyStateManager: {
            getState: ctx.getProxyState,
            saveState: ctx.saveProxyState,
            commitState: ctx.commitProxyState
        },
        publishProxyState: ctx.publishProxyState
    };
}

async function applyPreparedState(
    ctx: CommandContext,
    desiredFields: Partial<ProxyState>,
    fromMode: ProxyMode
): Promise<boolean> {
    const committed = await commitToggleDesiredState(ctx, desiredFields, fromMode);
    if (!committed) {
        // Another writer owns the state now; nothing is owed, like a
        // superseded fenced apply. Refresh the status bar from what they saved.
        ctx.updateStatusBar(await ctx.getProxyState());
        return true;
    }

    const newActiveUrl = ctx.getActiveProxyUrl(committed);

    // Off stops the monitor before the removal so a queued check cannot race
    // the unset. Auto starts it only after the apply; both read the committed
    // mode, which now is the desired one.
    if (committed.mode === ProxyMode.Off) {
        await ctx.stopSystemProxyMonitoring();
    }

    const applied = await ctx.applyProxySettings(
        newActiveUrl,
        committed.mode !== ProxyMode.Off && Boolean(newActiveUrl)
    );

    if (committed.mode === ProxyMode.Auto) {
        await ctx.startSystemProxyMonitoring();
    }

    await clearPendingThenPublish(toggleConvergenceContext(ctx), 'toggle', committed);

    // ProxyApplier records per-target success/failure in state. Refresh from that
    // authoritative result instead of presenting the pre-apply desired snapshot.
    ctx.updateStatusBar(await ctx.getProxyState());
    return applied;
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
        const fromMode = currentState.mode;
        const nextMode = ctx.getNextMode(currentState.mode);
        const i18n = I18nManager.getInstance();

        const preToggleSnapshot = { ...currentState };
        await prepareNextMode(ctx, currentState, nextMode, i18n);
        const applied = await applyPreparedState(
            ctx,
            changedToggleFields(preToggleSnapshot, currentState),
            fromMode
        );

        return { success: applied };
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
