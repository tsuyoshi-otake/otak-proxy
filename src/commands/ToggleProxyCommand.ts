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
import {
    clearPendingThenPublish,
    commitDecidedPatch,
    diffProxyState,
    ApplyConvergenceContext,
    DecidedPatchWriter
} from '../core/ApplyConvergence';
import { captureLogicalGeneration, sameLogicalIdentity } from '../core/LogicalGeneration';
import { ProxyMode, type ProxyState, type ProxyTestResult } from '../core/types';
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
 * User-visible effects a decided state wants after the transition commits.
 * Collected during the decision and run only for the round whose commit
 * landed: a superseded or failed round must not leave a "using manual proxy"
 * toast or a setup prompt behind.
 */
type ToggleFollowUp = () => void;

/**
 * No manual proxy URL is configured. There's nothing to switch into, so
 * redirect to Auto OFF immediately (releasing the toggle queue) and show the
 * "configure now?" prompt as a detached follow-up notification.
 *
 * NOTE: currently unreachable via the Off<->Auto toggle cycle
 * (ProxyStateManager.getNextMode never returns ProxyMode.Manual). Kept fixed
 * defensively for any future caller that targets Manual mode directly.
 */
function handleManualProxyMissing(state: ProxyState, i18n: I18nManager, followUps: ToggleFollowUp[]): void {
    state.mode = ProxyMode.Auto;
    state.autoModeOff = true;

    followUps.push(() => {
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
    });
}

function applyReachableFallbackProxy(
    ctx: CommandContext,
    state: ProxyState,
    manualProxyUrl: string,
    followUps: ToggleFollowUp[]
): void {
    state.mode = ProxyMode.Auto;
    state.autoModeOff = false;
    state.usingFallbackProxy = true;
    state.fallbackProxyUrl = manualProxyUrl;
    state.autoProxyUrl = manualProxyUrl;
    state.lastDetectionSource = 'fallback';
    setRequiresAuthFromLiveUrls(state);

    const sanitizedManualProxyUrl = ctx.sanitizer.maskPassword(manualProxyUrl);
    Logger.log(`Fallback to Manual Proxy: ${sanitizedManualProxyUrl}`);
    followUps.push(() => {
        ctx.userNotifier.showSuccess('fallback.usingManualProxy', { url: sanitizedManualProxyUrl });
    });
}

async function tryApplyManualFallback(
    ctx: CommandContext,
    state: ProxyState,
    followUps: ToggleFollowUp[]
): Promise<boolean> {
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
        applyReachableFallbackProxy(ctx, state, manualProxyUrl, followUps);
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
function handleSystemProxySetupPrompt(state: ProxyState, i18n: I18nManager, followUps: ToggleFollowUp[]): void {
    setAutoModeOff(state);

    followUps.push(() => {
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
    });
}

function useDetectedAutoProxy(state: ProxyState, nextMode: ProxyMode): void {
    state.mode = nextMode;
    state.autoModeOff = false;
    state.usingFallbackProxy = false;
    state.fallbackProxyUrl = undefined;
}

/**
 * Decides the desired state on a copy of the basis the round re-read. The
 * toggle's own detection already ran (and committed) before this, so the
 * basis is post-detection: nothing here writes to the store, the decision is
 * folded onto the latest state by the CAS commit.
 */
async function decideNextState(
    ctx: CommandContext,
    decided: ProxyState,
    nextMode: ProxyMode,
    detectionRan: boolean,
    i18n: I18nManager,
    followUps: ToggleFollowUp[]
): Promise<void> {
    if (nextMode === ProxyMode.Manual && !decided.manualProxyUrl) {
        handleManualProxyMissing(decided, i18n, followUps);
        return;
    }

    if (nextMode === ProxyMode.Auto && detectionRan) {
        if (decided.autoProxyUrl) {
            useDetectedAutoProxy(decided, nextMode);
            return;
        }

        if (await tryApplyManualFallback(ctx, decided, followUps)) {
            return;
        }

        handleSystemProxySetupPrompt(decided, i18n, followUps);
        return;
    }

    decided.mode = nextMode;
}

/**
 * Bound on decide-and-commit rounds. A same-mode identity change (a newer
 * detection or a manual URL edit) moves the basis the decision was made on,
 * so the toggle decides again on the fresh state; a mode change supersedes
 * instead. Bounded so a constantly moving state fails the toggle instead of
 * spinning.
 */
const TOGGLE_MAX_ROUNDS = 3;

function toggleWriter(ctx: CommandContext): DecidedPatchWriter {
    return {
        getState: ctx.getProxyState,
        commitState: ctx.commitProxyState
    };
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

/**
 * The toggle could not land its decision: every CAS attempt lost the race or
 * the basis kept moving under it. Nothing was saved or applied, so report the
 * failure instead of silently returning success (#78).
 */
async function failToggle(ctx: CommandContext): Promise<CommandResult> {
    Logger.warn('Toggle proxy failed: proxy state kept changing under the commit window.');
    ctx.userNotifier.showError(
        'error.toggleFailed',
        ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
    );
    ctx.updateStatusBar(await ctx.getProxyState());
    return { success: false };
}

/**
 * Applies a committed desired state. Off stops the monitor before the removal
 * so a queued check cannot race the unset; Auto starts it after the pending
 * flag is cleared and published, so the immediate check inside
 * startSystemProxyMonitoring cannot publish a still-pending state to other
 * windows (#78).
 */
async function applyCommittedToggle(ctx: CommandContext, committed: ProxyState): Promise<boolean> {
    const newActiveUrl = ctx.getActiveProxyUrl(committed);

    if (committed.mode === ProxyMode.Off) {
        await ctx.stopSystemProxyMonitoring();
    }

    const applied = await ctx.applyProxySettings(
        newActiveUrl,
        committed.mode !== ProxyMode.Off && Boolean(newActiveUrl)
    );

    await clearPendingThenPublish(toggleConvergenceContext(ctx), 'toggle', committed);

    if (committed.mode === ProxyMode.Auto) {
        await ctx.startSystemProxyMonitoring();
    }

    // ProxyApplier records per-target success/failure in state. Refresh from that
    // authoritative result instead of presenting the pre-apply desired snapshot.
    ctx.updateStatusBar(await ctx.getProxyState());
    return applied;
}

/**
 * The user asked for `nextMode` from `fromMode`; both were fixed by the first
 * read. A later round whose basis shows a different mode means another writer
 * moved the state — the toggle is superseded and owes nothing but the status
 * bar, exactly like `moved` with a different mode.
 */
async function supersedeToggle(ctx: CommandContext, latest: ProxyState): Promise<CommandResult> {
    ctx.updateStatusBar(latest);
    return { success: true };
}

/** `false` asks the caller for another round; a CommandResult ends the toggle. */
async function runToggleRound(
    ctx: CommandContext,
    i18n: I18nManager,
    fromMode: ProxyMode,
    nextMode: ProxyMode
): Promise<CommandResult | false> {
    let basis = await ctx.getProxyState();
    if (basis.mode !== fromMode) {
        return supersedeToggle(ctx, basis);
    }

    // The toggle's own detection commits its results to the store; decide on
    // the state as it stands afterwards, not on a snapshot taken before.
    const detectionRan = nextMode === ProxyMode.Auto && !basis.autoProxyUrl;
    if (detectionRan) {
        await ctx.checkAndUpdateSystemProxy();
        basis = await ctx.getProxyState();
        if (basis.mode !== fromMode) {
            return supersedeToggle(ctx, basis);
        }
    }

    const decided = { ...basis };
    const followUps: ToggleFollowUp[] = [];
    await decideNextState(ctx, decided, nextMode, detectionRan, i18n, followUps);

    const patch: Partial<ProxyState> = {
        ...diffProxyState(basis, decided),
        convergencePending: true
    };
    const basisGeneration = captureLogicalGeneration(basis);
    const outcome = await commitDecidedPatch(
        toggleWriter(ctx),
        patch,
        latest => latest.mode === fromMode &&
            sameLogicalIdentity(basisGeneration, captureLogicalGeneration(latest))
    );

    if (outcome.kind === 'committed') {
        const applied = await applyCommittedToggle(ctx, outcome.state);
        // Only the round whose commit landed runs its follow-ups; a moved or
        // failed round's prompts and toasts are dropped with its decision.
        for (const followUp of followUps) {
            followUp();
        }
        return { success: applied };
    }

    if (outcome.kind === 'moved') {
        if (outcome.state.mode !== fromMode) {
            // Another writer owns the state now; nothing is owed, like a
            // superseded fenced apply. Refresh the status bar from what they saved.
            return supersedeToggle(ctx, outcome.state);
        }
        // Same mode, different identity: decide again on the fresh basis.
        return false;
    }

    return failToggle(ctx);
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
        const i18n = I18nManager.getInstance();
        // The toggle's intent is fixed by the first read: a re-decide round
        // may fold onto newer same-mode state, but it must never retarget the
        // mode another writer chose in the meantime.
        const first = await ctx.getProxyState();
        const fromMode = first.mode;
        const nextMode = ctx.getNextMode(fromMode);
        for (let round = 0; round < TOGGLE_MAX_ROUNDS; round++) {
            const result = await runToggleRound(ctx, i18n, fromMode, nextMode);
            if (result !== false) {
                return result;
            }
        }
        return failToggle(ctx);
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
