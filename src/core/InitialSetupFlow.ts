import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { isUnsupportedAutoConfig } from '../config/SystemProxyDetector';
import { unsupportedAutoConfigKindLabel } from '../diagnostics/unsupportedAutoConfig';
import { canonicalizeValidProxyUrl, detectSystemProxySettingsWithSource, validateProxyUrl } from '../utils/ProxyUtils';
import { removeProxyCredentials, setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';
import { commitDecidedPatch, diffProxyState } from './ApplyConvergence';
import { InitializerContext } from './ExtensionInitializerTypes';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import { AppliedProxySource, ProxyMode, ProxyState } from './types';
import { Logger } from '../utils/Logger';

export class InitialSetupFlow {
    constructor(
        private readonly context: InitializerContext,
        private readonly startSystemProxyMonitoring: () => Promise<void>
    ) {}

    /**
     * Ask for initial setup.
     *
     * Returns `false` when the setup must be offered again on the next start:
     * the user's answer could not be stored (the commit was exhausted, and the
     * error is reported), or Auto detection failed (kind `unknown`) and the
     * user neither configured a proxy nor re-detected. Every other end —
     * stored, skipped, dismissed, invalid URL, or superseded by another
     * writer — is `true`.
     */
    async askForInitialSetup(): Promise<boolean> {
        const state = await this.context.proxyStateManager.getState();
        const initialStateSignature = this.setupStateSignature(state);
        const i18n = I18nManager.getInstance();

        const modeAnswer = await vscode.window.showInformationMessage(
            i18n.t('prompt.initialSetup'),
            i18n.t('action.autoSystem'),
            i18n.t('action.manualSetup'),
            i18n.t('action.skip')
        );

        if (!await this.isSetupStateCurrent(initialStateSignature)) {
            Logger.log('Initial setup skipped because proxy state changed while the prompt was open.');
            return true;
        }

        if (modeAnswer === i18n.t('action.autoSystem')) {
            if (!await this.handleAutoSetup(state, i18n, initialStateSignature)) {
                return false;
            }
        } else if (modeAnswer === i18n.t('action.manualSetup')) {
            if (!await this.handleManualSetup(state, i18n, initialStateSignature)) {
                return false;
            }
        }

        // Some setup branches (notably configureUrl fallback) operate on a state
        // re-read after the command completes. Use the committed state, not the
        // stale object captured before the prompt, to finalize monitoring.
        const committedState = await this.context.proxyStateManager.getState();
        if (committedState.mode === ProxyMode.Auto) {
            await this.startSystemProxyMonitoring();
        }
        return true;
    }

    private setupStateSignature(state: ProxyState): string {
        return JSON.stringify({
            mode: state.mode,
            manualProxyUrl: state.manualProxyUrl || '',
            autoProxyUrl: state.autoProxyUrl || '',
            autoModeOff: state.autoModeOff === true,
            usingFallbackProxy: state.usingFallbackProxy === true,
            fallbackProxyUrl: state.fallbackProxyUrl || ''
        });
    }

    private async isSetupStateCurrent(initialStateSignature: string): Promise<boolean> {
        const currentState = await this.context.proxyStateManager.getState();
        return this.setupStateSignature(currentState) === initialStateSignature;
    }

    private async continueIfSetupStateCurrent(initialStateSignature: string): Promise<boolean> {
        if (await this.isSetupStateCurrent(initialStateSignature)) {
            return true;
        }

        Logger.log('Initial setup action skipped because proxy state changed while setup was waiting.');
        return false;
    }

    /**
     * Commits only the fields the setup decided, folded onto the latest state,
     * while the signature still matches the pre-prompt one. Saving the whole
     * pre-prompt object would roll back bookkeeping other writers committed
     * meanwhile (apply results, detection, test fields). On `moved` or
     * `exhausted` nothing is written and the branch stops. `moved` means
     * another writer owns the state and the setup is finished; `exhausted`
     * means the answer was not stored and is reported, so the setup is
     * offered again on the next start.
     */
    private async commitSetupDecision(
        prePromptState: ProxyState,
        decidedState: ProxyState,
        initialStateSignature: string
    ): Promise<'committed' | 'moved' | 'exhausted'> {
        const manager = this.context.proxyStateManager;
        const outcome = await commitDecidedPatch(
            {
                getState: () => manager.getState(),
                commitState: (expected, next) => manager.commitState(expected, next)
            },
            diffProxyState(prePromptState, decidedState),
            latest => this.setupStateSignature(latest) === initialStateSignature
        );
        if (outcome.kind === 'exhausted') {
            Logger.warn('Initial setup answer could not be saved: the proxy state kept changing under the commit window.');
            this.context.userNotifier.showError(
                'error.initialSetupNotSaved',
                ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
            );
            return 'exhausted';
        }
        if (outcome.kind === 'moved') {
            Logger.log('Initial setup action skipped because proxy state changed while setup was waiting.');
        }
        return outcome.kind;
    }

    private async handleAutoSetup(
        state: ProxyState,
        i18n: I18nManager,
        initialStateSignature: string
    ): Promise<boolean> {
        const detected = await detectSystemProxySettingsWithSource();
        const detectedProxy = detected.proxyUrl;

        if (isUnsupportedAutoConfig(detected)) {
            if (!await this.continueIfSetupStateCurrent(initialStateSignature)) {
                return true;
            }
            const decided: ProxyState = { ...state };
            decided.systemProxyDetected = true;
            decided.lastDetectionKind = detected.kind;
            decided.lastDetectionCapability = detected.capability;
            decided.lastDetectionSource = detected.source ?? undefined;
            const commitOutcome = await this.commitSetupDecision(state, decided, initialStateSignature);
            if (commitOutcome === 'exhausted') {
                return false;
            }
            if (commitOutcome !== 'committed') {
                return true;
            }
            const configure = await vscode.window.showWarningMessage(
                i18n.t('warning.unsupportedAutoConfig', {
                    kind: unsupportedAutoConfigKindLabel(detected.kind)
                }),
                i18n.t('action.configureManual'),
                i18n.t('action.no')
            );
            if (configure === i18n.t('action.configureManual')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
            }
            return true;
        }

        if (detectedProxy && validateProxyUrl(detectedProxy)) {
            if (!await this.continueIfSetupStateCurrent(initialStateSignature)) {
                return true;
            }
            const decided: ProxyState = { ...state };
            this.useAutoProxy(decided, detectedProxy, false, detected.source ?? undefined);
            const commitOutcome = await this.commitSetupDecision(state, decided, initialStateSignature);
            if (commitOutcome === 'exhausted') {
                return false;
            }
            if (commitOutcome !== 'committed') {
                return true;
            }
            const applied = await applyProxyThroughContext(this.context, detectedProxy, true);
            this.context.updateStatusBar?.(await this.context.proxyStateManager.getState());
            if (applied) {
                this.context.userNotifier.showSuccess(
                    'message.usingSystemProxy',
                    { url: this.context.sanitizer.maskPassword(detectedProxy) }
                );
            }
            return true;
        }

        if (detected.kind === 'unknown') {
            // The OS query failed: that is not a confirmed absence of a proxy, so
            // the setup is not finished on it and is offered again on the next
            // start unless the user configures a proxy or re-detects (#108).
            const action = await vscode.window.showWarningMessage(
                i18n.t('warning.detectionFailed'),
                i18n.t('action.configureManual'),
                i18n.t('action.redetect')
            );
            if (action === i18n.t('action.redetect')) {
                return await this.handleAutoSetup(state, i18n, initialStateSignature);
            }
            if (action === i18n.t('action.configureManual')) {
                await this.configureFallbackProxy(initialStateSignature);
                return true;
            }
            return false;
        }

        const fallback = await vscode.window.showInformationMessage(
            i18n.t('prompt.couldNotDetect'),
            i18n.t('action.yes'),
            i18n.t('action.no')
        );

        if (fallback === i18n.t('action.yes')) {
            await this.configureFallbackProxy(initialStateSignature);
        }
        return true;
    }

    private async configureFallbackProxy(initialStateSignature: string): Promise<void> {
        if (!await this.continueIfSetupStateCurrent(initialStateSignature)) {
            return;
        }
        await vscode.commands.executeCommand('otak-proxy.configureUrl');
        const updatedState = await this.context.proxyStateManager.getState();
        if (updatedState.manualProxyUrl) {
            this.useAutoProxy(updatedState, updatedState.manualProxyUrl, true);
            await this.context.proxyStateManager.saveState(updatedState);
            await applyProxyThroughContext(this.context, updatedState.manualProxyUrl, true);
            this.context.updateStatusBar?.(await this.context.proxyStateManager.getState());
        }
    }

    private async handleManualSetup(
        state: ProxyState,
        i18n: I18nManager,
        initialStateSignature: string
    ): Promise<boolean> {
        const manualProxyUrl = await vscode.window.showInputBox({
            prompt: i18n.t('prompt.proxyUrl'),
            placeHolder: i18n.t('prompt.proxyUrlPlaceholder')
        });

        if (!manualProxyUrl) {
            return true;
        }

        const canonicalUrl = canonicalizeValidProxyUrl(manualProxyUrl);
        if (!canonicalUrl) {
            this.context.userNotifier.showError(
                'error.invalidProxyUrl',
                [
                    'suggestion.useFormat',
                    'suggestion.includeProtocol',
                    'suggestion.validHostname'
                ]
            );
            return true;
        }

        if (!await this.continueIfSetupStateCurrent(initialStateSignature)) {
            return true;
        }

        const decided: ProxyState = { ...state };
        decided.manualProxyUrl = canonicalUrl;
        this.useAutoProxy(decided, canonicalUrl, true);
        const commitOutcome = await this.commitSetupDecision(state, decided, initialStateSignature);
        if (commitOutcome === 'exhausted') {
            return false;
        }
        if (commitOutcome !== 'committed') {
            return true;
        }

        await vscode.workspace.getConfiguration('otakProxy').update(
            'proxyUrl',
            removeProxyCredentials(canonicalUrl) || canonicalUrl,
            vscode.ConfigurationTarget.Global
        );

        const applied = await applyProxyThroughContext(this.context, canonicalUrl, true);
        this.context.updateStatusBar?.(await this.context.proxyStateManager.getState());
        if (applied) {
            this.context.userNotifier.showSuccess(
                'message.manualProxyConfigured',
                { url: this.context.sanitizer.maskPassword(canonicalUrl) }
            );
        }
        return true;
    }

    private useAutoProxy(
        state: ProxyState,
        proxyUrl: string,
        fallback: boolean,
        detectedSource?: AppliedProxySource
    ): void {
        state.mode = ProxyMode.Auto;
        state.autoProxyUrl = proxyUrl;
        state.autoModeOff = false;
        state.usingFallbackProxy = fallback;
        state.fallbackProxyUrl = fallback ? proxyUrl : undefined;
        state.lastDetectionSource = fallback ? 'fallback' : detectedSource;
        setRequiresAuthFromLiveUrls(state);
    }
}
