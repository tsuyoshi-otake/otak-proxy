import * as vscode from 'vscode';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { Logger } from '../utils/Logger';
import { detectSystemProxySettingsWithSource } from '../utils/ProxyUtils';
import { InitializerContext } from './ExtensionInitializerTypes';
import { commitUnlessStale, publishUnlessStale } from './GenerationFence';
import { LogicalGeneration, captureLogicalGeneration, isStaleGeneration, sameLogicalIdentity } from './LogicalGeneration';
import { applyProxyThroughContext } from './ProxyApplyInvoker';
import { AppliedProxySource, ProxyMode, ProxyState } from './types';
import { setRequiresAuthFromLiveUrls } from '../utils/ProxyStateSanitizer';

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

        const started = captureLogicalGeneration(stateBeforeDetection);
        const detected = await detectSystemProxySettingsWithSource();
        const detectedProxy = detected.proxyUrl;
        const detectedSource: AppliedProxySource | undefined = detected.source ?? undefined;
        // Detection can wait on several external sources. Re-read after it so a
        // newer toggle/sync decision owns finalization instead of being overwritten
        // by the stale pre-detection snapshot (#17, #27).
        const state = await this.context.proxyStateManager.getState();
        if (isStaleGeneration(started, state)) {
            if (state.mode !== ProxyMode.Auto) {
                await this.saveDetectedProxyForNonAutoMode(
                    captureLogicalGeneration(state),
                    state,
                    detectedProxy,
                    detectedSource
                );
            }
            return;
        }
        state.lastSystemProxyCheck = now;
        state.systemProxyDetected = !!detectedProxy;

        if (state.mode === ProxyMode.Auto) {
            await this.updateAutoProxyState(started, state, detectedProxy, detectedSource);
            return;
        }

        await this.saveDetectedProxyForNonAutoMode(started, state, detectedProxy, detectedSource);
    }

    private shouldSkipRecentNonAutoCheck(state: ProxyState, now: number): boolean {
        return Boolean(
            state.mode !== ProxyMode.Auto &&
            state.lastSystemProxyCheck &&
            (now - state.lastSystemProxyCheck) < 300000 &&
            state.autoProxyUrl
        );
    }

    private async updateAutoProxyState(
        started: LogicalGeneration,
        state: ProxyState,
        detectedProxy: string | null,
        detectedSource: AppliedProxySource | undefined
    ): Promise<void> {
        const previousProxy = state.autoProxyUrl;
        const wasAutoModeOff = state.autoModeOff === true;

        if (detectedProxy) {
            this.applyDetectedProxyState(state, detectedProxy, detectedSource);
        } else {
            await this.applyFallbackProxyState(state);
        }

        if (
            previousProxy === state.autoProxyUrl &&
            !wasAutoModeOff &&
            !this.hasKnownConvergenceFailure(state, Boolean(state.autoProxyUrl)) &&
            !this.shouldEnsureDisabledProxy(state)
        ) {
            await this.saveAndPublishState(started, state);
            return;
        }

        await this.saveAndApplyAutoProxyState(started, state, previousProxy);
    }

    private applyDetectedProxyState(
        state: ProxyState,
        detectedProxy: string,
        detectedSource: AppliedProxySource | undefined
    ): void {
        state.autoProxyUrl = detectedProxy;
        state.autoModeOff = false;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        state.lastDetectionSource = detectedSource;
        setRequiresAuthFromLiveUrls(state);
    }

    private async saveAndApplyAutoProxyState(
        started: LogicalGeneration,
        state: ProxyState,
        previousProxy: string | undefined
    ): Promise<void> {
        const pending = await commitUnlessStale(this.context.proxyStateManager, started, 'detection', current => ({
            ...current,
            ...state,
            revision: current.revision,
            convergencePending: true
        }));
        if (pending === 'stale') {
            return;
        }

        const activeProxyUrl = state.autoProxyUrl || '';
        const applied = await applyProxyThroughContext(
            this.context,
            activeProxyUrl,
            Boolean(activeProxyUrl),
            activeProxyUrl ? undefined : { silent: true }
        );

        const afterApply = await this.context.proxyStateManager.getState();
        if (!sameLogicalIdentity(
            captureLogicalGeneration({ ...state, revision: afterApply.revision }),
            captureLogicalGeneration(afterApply)
        )) {
            return;
        }

        await commitUnlessStale(
            this.context.proxyStateManager,
            captureLogicalGeneration(afterApply),
            'detection',
            current => ({ ...current, convergencePending: false })
        );
        const published = await this.context.proxyStateManager.getState();
        await publishUnlessStale(this.context.publishProxyState, captureLogicalGeneration(published), 'detection', published);
        if (applied) {
            this.notifyAutoProxyChange(state, previousProxy);
        }
        this.context.updateStatusBar?.(published);
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

    private async saveDetectedProxyForNonAutoMode(
        started: LogicalGeneration,
        state: ProxyState,
        detectedProxy: string | null,
        detectedSource: AppliedProxySource | undefined
    ): Promise<void> {
        state.autoProxyUrl = detectedProxy || undefined;
        state.lastDetectionSource = detectedProxy ? detectedSource : undefined;
        setRequiresAuthFromLiveUrls(state);
        await this.saveAndPublishState(started, state);
    }

    private async saveAndPublishState(started: LogicalGeneration, state: ProxyState): Promise<void> {
        const outcome = await commitUnlessStale(this.context.proxyStateManager, started, 'detection', current => ({
            ...current,
            lastSystemProxyCheck: state.lastSystemProxyCheck,
            systemProxyDetected: state.systemProxyDetected,
            autoProxyUrl: state.autoProxyUrl,
            lastDetectionSource: state.lastDetectionSource,
            autoModeOff: state.autoModeOff,
            usingFallbackProxy: state.usingFallbackProxy,
            fallbackProxyUrl: state.fallbackProxyUrl,
            requiresAuth: state.requiresAuth
        }));
        if (outcome === 'stale') {
            return;
        }

        const current = await this.context.proxyStateManager.getState();
        await publishUnlessStale(
            this.context.publishProxyState,
            captureLogicalGeneration(current),
            'detection',
            current
        );
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
                state.lastDetectionSource = 'fallback';
                setRequiresAuthFromLiveUrls(state);
                Logger.log(`Using fallback proxy: ${state.manualProxyUrl}`);
                return;
            }

            state.autoProxyUrl = undefined;
            state.autoModeOff = true;
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            state.lastDetectionSource = undefined;
            setRequiresAuthFromLiveUrls(state);
            Logger.log('Fallback proxy not reachable - Auto Mode OFF');
            return;
        }

        state.autoProxyUrl = undefined;
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        state.lastDetectionSource = undefined;
        setRequiresAuthFromLiveUrls(state);
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
