import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { detectSystemProxySettings, validateProxyUrl } from '../utils/ProxyUtils';
import { removeProxyCredentials } from '../utils/ProxyStateSanitizer';
import { InitializerContext } from './ExtensionInitializerTypes';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import { ProxyMode, ProxyState } from './types';

export class InitialSetupFlow {
    constructor(
        private readonly context: InitializerContext,
        private readonly startSystemProxyMonitoring: () => Promise<void>
    ) {}

    /**
     * Ask for initial setup.
     */
    async askForInitialSetup(): Promise<void> {
        const state = await this.context.proxyStateManager.getState();
        const i18n = I18nManager.getInstance();

        const modeAnswer = await vscode.window.showInformationMessage(
            i18n.t('prompt.initialSetup'),
            i18n.t('action.autoSystem'),
            i18n.t('action.manualSetup'),
            i18n.t('action.skip')
        );

        if (modeAnswer === i18n.t('action.autoSystem')) {
            await this.handleAutoSetup(state, i18n);
        } else if (modeAnswer === i18n.t('action.manualSetup')) {
            await this.handleManualSetup(state, i18n);
        }

        if (state.mode === ProxyMode.Auto) {
            await this.startSystemProxyMonitoring();
        }
    }

    private async handleAutoSetup(state: ProxyState, i18n: I18nManager): Promise<void> {
        const detectedProxy = await detectSystemProxySettings();

        if (detectedProxy && validateProxyUrl(detectedProxy)) {
            state.autoProxyUrl = detectedProxy;
            state.mode = ProxyMode.Auto;
            await this.context.proxyStateManager.saveState(state);
            await applyProxyThroughContext(this.context, detectedProxy, true);
            this.context.userNotifier.showSuccess(
                'message.usingSystemProxy',
                { url: this.context.sanitizer.maskPassword(detectedProxy) }
            );
            return;
        }

        const fallback = await vscode.window.showInformationMessage(
            i18n.t('prompt.couldNotDetect'),
            i18n.t('action.yes'),
            i18n.t('action.no')
        );

        if (fallback === i18n.t('action.yes')) {
            await vscode.commands.executeCommand('otak-proxy.configureUrl');
            const updatedState = await this.context.proxyStateManager.getState();
            if (updatedState.manualProxyUrl) {
                updatedState.mode = ProxyMode.Manual;
                await this.context.proxyStateManager.saveState(updatedState);
                await applyProxyThroughContext(this.context, updatedState.manualProxyUrl, true);
            }
        }
    }

    private async handleManualSetup(state: ProxyState, i18n: I18nManager): Promise<void> {
        const manualProxyUrl = await vscode.window.showInputBox({
            prompt: i18n.t('prompt.proxyUrl'),
            placeHolder: i18n.t('prompt.proxyUrlPlaceholder')
        });

        if (!manualProxyUrl) {
            return;
        }

        if (!validateProxyUrl(manualProxyUrl)) {
            this.context.userNotifier.showError(
                'error.invalidProxyUrl',
                [
                    'suggestion.useFormat',
                    'suggestion.includeProtocol',
                    'suggestion.validHostname'
                ]
            );
            return;
        }

        state.manualProxyUrl = manualProxyUrl;
        state.mode = ProxyMode.Manual;
        await this.context.proxyStateManager.saveState(state);

        await vscode.workspace.getConfiguration('otakProxy').update(
            'proxyUrl',
            removeProxyCredentials(manualProxyUrl) || manualProxyUrl,
            vscode.ConfigurationTarget.Global
        );

        await applyProxyThroughContext(this.context, manualProxyUrl, true);
        this.context.userNotifier.showSuccess(
            'message.manualProxyConfigured',
            { url: this.context.sanitizer.maskPassword(manualProxyUrl) }
        );
    }
}
