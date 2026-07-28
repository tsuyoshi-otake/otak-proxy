import * as vscode from 'vscode';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { Logger } from '../utils/Logger';
import { detectSystemProxySettings } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import { ProxyMode, ProxyState } from './types';

export class SystemProxyUpdateService {
    constructor(
        private readonly context: InitializerContext,
        private readonly getConnectionTester: () => ProxyConnectionTester | null
    ) {}

    /**
     * Check and update system proxy.
     */
    async checkAndUpdateSystemProxy(): Promise<void> {
        const stateBeforeDetection = await this.context.proxyStateManager.getState();

        const now = Date.now();
        if (this.shouldSkipRecentNonAutoCheck(stateBeforeDetection, now)) {
            return;
        }

        const detectedProxy = await detectSystemProxySettings();
        // Detection can wait on several external sources. Re-read after it so a
        // newer toggle/sync decision owns finalization instead of being overwritten
        // by the stale pre-detection snapshot (#17, #27).
        const state = await this.context.proxyStateManager.getState();
        state.lastSystemProxyCheck = now;
        state.systemProxyDetected = !!detectedProxy;

        if (state.mode === ProxyMode.Auto) {
            await this.updateAutoProxyState(state, detectedProxy);
            return;
        }

        await this.saveDetectedProxyForNonAutoMode(state, detectedProxy);
    }

    private shouldSkipRecentNonAutoCheck(state: ProxyState, now: number): boolean {
        return Boolean(
            state.mode !== ProxyMode.Auto &&
            state.lastSystemProxyCheck &&
            (now - state.lastSystemProxyCheck) < 300000 &&
            state.autoProxyUrl
        );
    }

    private async updateAutoProxyState(state: ProxyState, detectedProxy: string | null): Promise<void> {
        const previousProxy = state.autoProxyUrl;
        const wasAutoModeOff = state.autoModeOff === true;

        if (detectedProxy) {
            this.applyDetectedProxyState(state, detectedProxy);
        } else {
            await this.applyFallbackProxyState(state);
        }

        if (
            previousProxy === state.autoProxyUrl &&
            !wasAutoModeOff &&
            !this.hasKnownConvergenceFailure(state, Boolean(state.autoProxyUrl)) &&
            !this.shouldEnsureDisabledProxy(state)
        ) {
            await this.saveAndPublishState(state);
            return;
        }

        await this.saveAndApplyAutoProxyState(state, previousProxy);
    }

    private applyDetectedProxyState(state: ProxyState, detectedProxy: string): void {
        state.autoProxyUrl = detectedProxy;
        state.autoModeOff = false;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
    }

    private async saveAndApplyAutoProxyState(state: ProxyState, previousProxy: string | undefined): Promise<void> {
        await this.saveAndPublishState(state);
        const activeProxyUrl = state.autoProxyUrl || '';
        const applied = await applyProxyThroughContext(
            this.context,
            activeProxyUrl,
            Boolean(activeProxyUrl),
            activeProxyUrl ? undefined : { silent: true }
        );
        if (applied) {
            this.notifyAutoProxyChange(state, previousProxy);
        }
        this.context.updateStatusBar?.(await this.context.proxyStateManager.getState());
    }

    private shouldEnsureDisabledProxy(state: ProxyState): boolean {
        return !state.autoProxyUrl && state.autoModeOff === true && !state.usingFallbackProxy;
    }

    private hasKnownConvergenceFailure(state: ProxyState, enabled: boolean): boolean {
        const observed = [
            state.gitConfigured,
            state.vscodeConfigured,
            state.npmConfigured,
            state.pipConfigured,
            state.terminalEnvConfigured
        ];
        return observed.some(value => typeof value === 'boolean' && value !== enabled);
    }

    private notifyAutoProxyChange(state: ProxyState, previousProxy: string | undefined): void {
        if (state.autoProxyUrl && !state.usingFallbackProxy) {
            this.context.userNotifier.showSuccess(
                'message.systemProxyChanged',
                { url: this.context.sanitizer.maskPassword(state.autoProxyUrl) }
            );
            return;
        }

        if (state.usingFallbackProxy) {
            this.context.userNotifier.showSuccess(
                'fallback.usingManualProxy',
                { url: this.context.sanitizer.maskPassword(state.autoProxyUrl!) }
            );
            return;
        }

        if (previousProxy) {
            this.context.userNotifier.showSuccess('message.systemProxyRemoved');
        }
    }

    private async saveDetectedProxyForNonAutoMode(state: ProxyState, detectedProxy: string | null): Promise<void> {
        state.autoProxyUrl = detectedProxy || undefined;
        await this.saveAndPublishState(state);
    }

    private async saveAndPublishState(state: ProxyState): Promise<void> {
        await this.context.proxyStateManager.saveState(state);

        if (!this.context.publishProxyState) {
            return;
        }

        try {
            await this.context.publishProxyState(state);
        } catch (error) {
            Logger.warn('Failed to publish proxy state:', error);
        }
    }

    private async applyFallbackProxyState(state: ProxyState): Promise<void> {
        const config = vscode.workspace.getConfiguration('otakProxy');
        const fallbackEnabled = config.get<boolean>('enableFallback', true);

        if (fallbackEnabled && state.manualProxyUrl) {
            const fallbackReachable = await this.isFallbackReachable(state.manualProxyUrl);

            if (fallbackReachable) {
                state.autoProxyUrl = state.manualProxyUrl;
                state.autoModeOff = false;
                state.usingFallbackProxy = true;
                state.fallbackProxyUrl = state.manualProxyUrl;
                Logger.log(`Using fallback proxy: ${state.manualProxyUrl}`);
                return;
            }

            state.autoProxyUrl = undefined;
            state.autoModeOff = true;
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            Logger.log('Fallback proxy not reachable - Auto Mode OFF');
            return;
        }

        state.autoProxyUrl = undefined;
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
    }

    private async isFallbackReachable(proxyUrl: string): Promise<boolean> {
        const connectionTester = this.getConnectionTester();
        if (!connectionTester) {
            return false;
        }

        Logger.log(`Testing fallback proxy: ${proxyUrl}`);
        const testResult = await connectionTester.testProxyAuto(proxyUrl);
        return testResult.success;
    }
}
