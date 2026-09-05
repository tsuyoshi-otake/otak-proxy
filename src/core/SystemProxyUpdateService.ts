import * as vscode from 'vscode';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { Logger } from '../utils/Logger';
import { assignDetectedProxyToState, clearDetectedSplitFields, splitApplyOptionsFromState } from '../config/DetectedProxyValue';
import { isUnsupportedAutoConfig, type ProxyDetectionWithSource } from '../config/SystemProxyDetector';
import { unsupportedAutoConfigKindLabel } from '../diagnostics/unsupportedAutoConfig';
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
                    detected,
                    detectedSource
                );
            }
            return;
        }
        state.lastSystemProxyCheck = now;
        state.systemProxyDetected = !!detectedProxy || isUnsupportedAutoConfig(detected);

        if (state.mode === ProxyMode.Auto) {
            await this.updateAutoProxyState(started, state, detected, detectedSource);
            return;
        }

        await this.saveDetectedProxyForNonAutoMode(started, state, detected, detectedSource);
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
        detected: ProxyDetectionWithSource,
        detectedSource: AppliedProxySource | undefined
    ): Promise<void> {
        const previousProxy = state.autoProxyUrl;
        const previousHttps = state.autoHttpsProxyUrl;
        const wasAutoModeOff = state.autoModeOff === true;
        const previousKind = state.lastDetectionKind;
        const detectedProxy = detected.proxyUrl;

        if (detectedProxy) {
            this.applyDetectedProxyState(state, detected, detectedSource);
        } else if (isUnsupportedAutoConfig(detected)) {
            await this.applyUnsupportedAutoConfigState(state, detected);
            if (!state.usingFallbackProxy) {
                await this.saveAndPublishState(started, state);
                this.notifyUnsupportedAutoConfig(state, previousKind);
                this.context.updateStatusBar?.(await this.context.proxyStateManager.getState());
                return;
            }
        } else {
            this.clearAutoConfigMetadata(state);
            await this.applyFallbackProxyState(state);
        }

        if (
            previousProxy === state.autoProxyUrl &&
            previousHttps === state.autoHttpsProxyUrl &&
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
        detected: ProxyDetectionWithSource,
        detectedSource: AppliedProxySource | undefined
    ): void {
        assignDetectedProxyToState(state, detected);
        state.autoModeOff = false;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        state.lastDetectionSource = detectedSource;
        state.lastDetectionKind = detected.kind ?? 'singleProxy';
        state.lastDetectionCapability = detected.capability ?? 'supported';
        setRequiresAuthFromLiveUrls(state);
    }

    private async applyUnsupportedAutoConfigState(
        state: ProxyState,
        detected: ProxyDetectionWithSource
    ): Promise<void> {
        state.systemProxyDetected = true;
        state.autoModeOff = false;
        state.lastDetectionKind = detected.kind;
        state.lastDetectionCapability = detected.capability;
        state.lastDetectionSource = detected.source ?? undefined;
        clearDetectedSplitFields(state);

        const config = vscode.workspace.getConfiguration('otakProxy');
        const fallbackEnabled = config.get<boolean>('enableFallback', true);

        if (fallbackEnabled && state.manualProxyUrl && await this.isFallbackReachable(state.manualProxyUrl)) {
            state.autoProxyUrl = state.manualProxyUrl;
            state.usingFallbackProxy = true;
            state.fallbackProxyUrl = state.manualProxyUrl;
            setRequiresAuthFromLiveUrls(state);
            Logger.log(`Ignoring unsupported auto-config (${detected.kind}); using fallback proxy`);
            return;
        }

        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        setRequiresAuthFromLiveUrls(state);
        Logger.log(`System auto-config detected but unsupported (${detected.kind})`);
    }

    private clearAutoConfigMetadata(state: ProxyState): void {
        state.lastDetectionKind = 'direct';
        state.lastDetectionCapability = 'supported';
    }

    private notifyUnsupportedAutoConfig(
        state: ProxyState,
        previousKind: ProxyState['lastDetectionKind']
    ): void {
        if (previousKind === 'pac' || previousKind === 'wpad') {
            return;
        }
        this.context.userNotifier.showWarning(
            'warning.unsupportedAutoConfig',
            { kind: unsupportedAutoConfigKindLabel(state.lastDetectionKind) }
        );
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
            activeProxyUrl ? splitApplyOptionsFromState(state) : { silent: true }
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
        detected: ProxyDetectionWithSource,
        detectedSource: AppliedProxySource | undefined
    ): Promise<void> {
        if (isUnsupportedAutoConfig(detected)) {
            state.lastDetectionSource = detected.source ?? undefined;
            state.lastDetectionKind = detected.kind;
            state.lastDetectionCapability = detected.capability;
            clearDetectedSplitFields(state);
            setRequiresAuthFromLiveUrls(state);
            await this.saveAndPublishState(started, state);
            return;
        }

        if (detected.proxyUrl) {
            assignDetectedProxyToState(state, detected);
            state.lastDetectionSource = detectedSource;
            state.lastDetectionKind = detected.kind ?? 'singleProxy';
            state.lastDetectionCapability = detected.capability ?? 'supported';
        } else {
            state.autoProxyUrl = undefined;
            state.lastDetectionSource = undefined;
            state.lastDetectionKind = 'direct';
            state.lastDetectionCapability = 'supported';
            clearDetectedSplitFields(state);
        }
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
            requiresAuth: state.requiresAuth,
            autoProxyKind: state.autoProxyKind,
            autoHttpProxyUrl: state.autoHttpProxyUrl,
            autoHttpsProxyUrl: state.autoHttpsProxyUrl,
            detectedBypass: state.detectedBypass,
            lastDetectionKind: state.lastDetectionKind,
            lastDetectionCapability: state.lastDetectionCapability
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
                clearDetectedSplitFields(state);
                setRequiresAuthFromLiveUrls(state);
                Logger.log(`Using fallback proxy: ${state.manualProxyUrl}`);
                return;
            }

            state.autoProxyUrl = undefined;
            state.autoModeOff = true;
            state.usingFallbackProxy = false;
            state.fallbackProxyUrl = undefined;
            state.lastDetectionSource = undefined;
            clearDetectedSplitFields(state);
            setRequiresAuthFromLiveUrls(state);
            Logger.log('Fallback proxy not reachable - Auto Mode OFF');
            return;
        }

        state.autoProxyUrl = undefined;
        state.autoModeOff = true;
        state.usingFallbackProxy = false;
        state.fallbackProxyUrl = undefined;
        state.lastDetectionSource = undefined;
        clearDetectedSplitFields(state);
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
