import * as vscode from 'vscode';
import { GitConfigManager, GitProxyKey } from '../config/GitConfigManager';
import { VscodeConfigManager } from '../config/VscodeConfigManager';
import { NpmConfigManager, NpmProxyKey } from '../config/NpmConfigManager';
import { PipConfigManager } from '../config/PipConfigManager';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { UserNotifier } from '../errors/UserNotifier';
import { ErrorAggregator } from '../errors/ErrorAggregator';
import { I18nManager } from '../i18n/I18nManager';
import { Logger } from '../utils/Logger';
import { ProxyStateManager } from './ProxyStateManager';
import {
    ProxyApplyDetailedResult,
    ProxyApplyOptions,
    ProxyConfigResults,
    ProxyConfigStatusReporter,
    ProxyConfigTarget,
    ProxyConfigTargetUpdateResult,
    ProxyOwnershipInspection,
    ProxyOwnershipObservation,
    OwnedTargetUnsetRequest
} from './ProxyApplierTypes';
import { updateProxyConfigTargetDetailed } from './ProxyConfigTargetRunner';
import { captureLogicalGeneration } from './LogicalGeneration';
import { saveProxyConfigResults } from './ProxyConfigStateTracker';
import { buildProxyValidationSuggestions } from './ProxyValidationMessages';
import {
    showAggregatedErrors,
    showProxyConfigured,
    showProxyDisabled
} from './ProxyApplierNotifications';
import { TargetOwnershipStore } from './TargetOwnershipStore';
import { hasProxyCredentials, removeProxyCredentials } from '../utils/ProxyStateSanitizer';
import { isPerSchemeProxy } from '../config/DetectedProxyValue';
import { splitCapabilityIssues } from './ProxyTargetCapability';
import { ProxyIssue } from './v3Types';

/**
 * ProxyApplier handles the application and removal of proxy settings
 * across all configuration targets (Git, VSCode, npm).
 * 
 * Requirement 4.1: Unified handling of ConfigManager calls
 * Requirement 4.2: Sequential execution of validation, application, and error aggregation
 * Requirement 4.3: Complete proxy disablement across all managers
 * Requirement 4.4: Error aggregation using ErrorAggregator
 */
export class ProxyApplier {
    constructor(
        private gitManager: GitConfigManager,
        private vscodeManager: VscodeConfigManager,
        private npmManager: NpmConfigManager,
        private validator: ProxyUrlValidator,
        private sanitizer: InputSanitizer,
        private userNotifier: UserNotifier,
        private stateManager?: ProxyStateManager,
        private terminalEnvManager?: TerminalEnvConfigManager,
        private pipManager?: PipConfigManager,
        private ownershipStore?: TargetOwnershipStore
    ) {}

    private isWorkspaceTrusted(): boolean {
        return vscode.workspace.isTrusted !== false;
    }

    private blockIfUntrustedWorkspace(options?: { silent?: boolean }): boolean {
        if (this.isWorkspaceTrusted()) {
            return false;
        }

        const message = 'Proxy settings were not changed because the workspace is untrusted.';
        Logger.warn(message);
        if (!options?.silent) {
            this.userNotifier.showWarning(message);
        }
        return true;
    }

    private async withOptionalProgress<T>(
        options: ProxyApplyOptions | undefined,
        task: (reportStatus?: ProxyConfigStatusReporter) => Promise<T>
    ): Promise<T> {
        if (!options?.showProgress || options.silent) {
            return task();
        }

        const i18n = I18nManager.getInstance();
        return this.userNotifier.showProgressNotification(
            i18n.t('progress.title.applyingSettings'),
            async progress => task(messageKey => {
                progress.report({ message: i18n.t(messageKey) });
            }),
            false
        );
    }

    private getTargetProgressKey(target: ProxyConfigTarget, enabled: boolean): string {
        switch (target.name) {
            case 'Git configuration':
                return enabled ? 'progress.gitConfigApplying' : 'progress.gitConfigClearing';
            case 'VSCode configuration':
                return enabled ? 'progress.vscodeConfigApplying' : 'progress.vscodeConfigClearing';
            case 'npm configuration':
                return enabled ? 'progress.npmConfigApplying' : 'progress.npmConfigClearing';
            case 'Terminal environment':
                return enabled ? 'progress.terminalEnvApplying' : 'progress.terminalEnvClearing';
            default:
                return enabled ? 'progress.applyingProxySettings' : 'progress.clearingProxySettings';
        }
    }

    private validateProxyUrlForApply(proxyUrl: string): boolean {
        const validationResult = this.validator.validate(proxyUrl);
        if (validationResult.isValid) {
            return true;
        }

        const suggestions = buildProxyValidationSuggestions(validationResult.errors);
        this.userNotifier.showError('error.invalidProxyUrl', suggestions);
        return false;
    }

    private areConfigResultsSuccessful(results: ProxyConfigResults): boolean {
        return results.gitSuccess &&
            results.vscodeSuccess &&
            results.npmSuccess &&
            results.pipSuccess !== false &&
            results.terminalEnvSuccess;
    }

    private notifyApplyResult(
        proxyUrl: string,
        options: ProxyApplyOptions | undefined,
        errorAggregator: ErrorAggregator,
        capabilityIssues: readonly ProxyIssue[] = []
    ): void {
        if (errorAggregator.hasErrors()) {
            showAggregatedErrors(errorAggregator, this.userNotifier);
            return;
        }

        if (!options?.silent) {
            showProxyConfigured(proxyUrl, this.sanitizer, this.userNotifier);
            if (capabilityIssues.some(issue => issue.category === 'capabilityUnavailable')) {
                this.userNotifier.showWarning('warning.splitProxyPartial');
            }
        }
    }

    private notifyDisableResult(
        options: ProxyApplyOptions | undefined,
        errorAggregator: ErrorAggregator
    ): void {
        if (errorAggregator.hasErrors()) {
            showAggregatedErrors(errorAggregator, this.userNotifier);
            return;
        }

        if (!options?.silent) {
            showProxyDisabled(this.userNotifier);
        }
    }

    /**
     * Apply proxy settings to all configuration targets
     * 
     * @param proxyUrl - The proxy URL to apply
     * @param enabled - Whether to enable or disable the proxy
     * @param options - Optional flags; set `silent` to suppress success notifications
     *                  (useful for background sync or monitor-driven updates)
     * @returns Promise<boolean> - True if all operations succeeded
     */
    async applyProxy(proxyUrl: string, enabled: boolean, options?: ProxyApplyOptions): Promise<boolean> {
        const result = await this.applyProxyDetailed(proxyUrl, enabled, options);
        return result.success;
    }

    async applyProxyDetailed(proxyUrl: string, enabled: boolean, options?: ProxyApplyOptions): Promise<ProxyApplyDetailedResult> {
        const applyGeneration = this.stateManager
            ? captureLogicalGeneration(await this.stateManager.getState())
            : undefined;
        const errorAggregator = new ErrorAggregator();
        
        // Edge Case 1: Handle empty URL as disable proxy (Requirement 4.1)
        if (!proxyUrl || proxyUrl.trim() === '') {
            enabled = false;
        }
        
        // If disabling, use the dedicated disable function
        if (!enabled) {
            return await this.disableProxyDetailed(options);
        }

        if (this.blockIfUntrustedWorkspace(options)) {
            return this.buildDetailedResult(false, true, proxyUrl, this.emptyResults(), errorAggregator);
        }
        
        const applyOptions = await this.resolveApplyOptions(proxyUrl, options);

        // Requirement 1.1, 1.3, 1.4, 3.1: Validate proxy URL before any configuration
        if (this.isSplitApply(applyOptions)) {
            if (!this.validateProxyUrlForApply(applyOptions.httpUrl!) ||
                !this.validateProxyUrlForApply(applyOptions.httpsUrl!)) {
                return this.buildDetailedResult(false, true, proxyUrl, this.emptyResults(), errorAggregator);
            }
        } else if (proxyUrl && !this.validateProxyUrlForApply(proxyUrl)) {
            return this.buildDetailedResult(false, true, proxyUrl, this.emptyResults(), errorAggregator);
        }

        const capabilityIssues = this.isSplitApply(applyOptions)
            ? splitCapabilityIssues({
                kind: applyOptions.kind,
                httpUrl: applyOptions.httpUrl,
                httpsUrl: applyOptions.httpsUrl,
                bypass: applyOptions.bypass,
                source: 'apply'
            })
            : applyOptions.bypass
                ? splitCapabilityIssues({ bypass: applyOptions.bypass, source: 'apply' })
                : [];
        
        const results = await this.withOptionalProgress(
            options,
            async reportStatus => this.updateTargets(
                this.getApplyTargets(),
                true,
                proxyUrl,
                errorAggregator,
                reportStatus,
                applyOptions
            )
        );

        // Track configuration state if stateManager is provided
        await saveProxyConfigResults(this.stateManager, true, results, errorAggregator, applyGeneration);

        const success = this.areConfigResultsSuccessful(results);
        
        // Requirement 2.5: Use ErrorAggregator to display all errors together
        this.notifyApplyResult(proxyUrl, options, errorAggregator, capabilityIssues);

        return this.buildDetailedResult(success, true, proxyUrl, results, errorAggregator, capabilityIssues);
    }

    /**
     * Disable proxy settings across all configuration targets
     * Requirement 2.5: Use ErrorAggregator and UserNotifier for comprehensive error handling
     * 
     * @param options - Optional flags; set `silent` to suppress success notifications
     * @returns Promise<boolean> - True if all operations succeeded
     */
    async disableProxy(options?: ProxyApplyOptions): Promise<boolean> {
        const result = await this.disableProxyDetailed(options);
        return result.success;
    }

    async disableProxyDetailed(options?: ProxyApplyOptions): Promise<ProxyApplyDetailedResult> {
        const applyGeneration = this.stateManager
            ? captureLogicalGeneration(await this.stateManager.getState())
            : undefined;
        const errorAggregator = new ErrorAggregator();

        if (this.blockIfUntrustedWorkspace(options)) {
            return this.buildDetailedResult(false, false, '', this.emptyResults(), errorAggregator);
        }
        
        const results = await this.withOptionalProgress(
            options,
            async reportStatus => this.updateTargets(
                this.getDisableTargets(),
                false,
                '',
                errorAggregator,
                reportStatus
            )
        );

        // Track configuration state if stateManager is provided
        await saveProxyConfigResults(this.stateManager, false, results, errorAggregator, applyGeneration);

        const success = this.areConfigResultsSuccessful(results);
        
        // Use ErrorAggregator for any failures and UserNotifier for feedback
        this.notifyDisableResult(options, errorAggregator);

        return this.buildDetailedResult(success, false, '', results, errorAggregator);
    }

    private emptyResults(): ProxyConfigResults {
        return {
            gitSuccess: false,
            vscodeSuccess: false,
            npmSuccess: false,
            pipSuccess: this.pipManager ? false : undefined,
            terminalEnvSuccess: false
        };
    }

    private buildDetailedResult(
        success: boolean,
        enabled: boolean,
        proxyUrl: string,
        results: ProxyConfigResults,
        errorAggregator: ErrorAggregator,
        issues: readonly ProxyIssue[] = []
    ): ProxyApplyDetailedResult {
        return {
            success,
            enabled,
            proxyUrl: this.sanitizer.maskPassword(proxyUrl),
            results,
            errors: errorAggregator.getErrors().map(error => ({
                target: error.operation,
                message: this.sanitizer.maskPassword(error.error),
                errorType: error.errorType
            })),
            issues: issues.length > 0 ? [...issues] : undefined
        };
    }

    private async resolveApplyOptions(proxyUrl: string, options?: ProxyApplyOptions): Promise<ProxyApplyOptions> {
        if (this.isSplitApply(options) || options?.bypass) {
            return options ?? {};
        }
        if (!this.stateManager) {
            return options ?? {};
        }

        try {
            const state = await this.stateManager.getState();
            if (!isPerSchemeProxy(state.autoProxyKind, state.autoHttpProxyUrl, state.autoHttpsProxyUrl)) {
                return {
                    ...options,
                    bypass: options?.bypass ?? state.detectedBypass
                };
            }

            const primary = state.autoHttpProxyUrl || state.autoProxyUrl;
            const publicPrimary = primary ? (removeProxyCredentials(primary) || primary) : undefined;
            const publicApplied = removeProxyCredentials(proxyUrl) || proxyUrl;
            if (publicPrimary && publicPrimary !== publicApplied) {
                return options ?? {};
            }

            return {
                ...options,
                kind: 'perSchemeProxy',
                httpUrl: state.autoHttpProxyUrl,
                httpsUrl: state.autoHttpsProxyUrl,
                bypass: options?.bypass ?? state.detectedBypass
            };
        } catch {
            return options ?? {};
        }
    }

    private isSplitApply(options?: ProxyApplyOptions): boolean {
        return isPerSchemeProxy(options?.kind, options?.httpUrl, options?.httpsUrl);
    }

    private async updateTargets(
        targets: ProxyConfigTarget[],
        enabled: boolean,
        proxyUrl: string,
        errorAggregator: ErrorAggregator,
        reportStatus?: ProxyConfigStatusReporter,
        applyOptions?: ProxyApplyOptions
    ): Promise<ProxyConfigResults> {
        const results: ProxyConfigResults = {
            gitSuccess: false,
            vscodeSuccess: false,
            npmSuccess: false,
            pipSuccess: this.pipManager ? false : undefined,
            terminalEnvSuccess: true
        };

        for (const target of targets) {
            reportStatus?.(this.getTargetProgressKey(target, enabled));
            const targetResult = await this.updateTarget(
                target,
                enabled,
                proxyUrl,
                errorAggregator,
                reportStatus,
                applyOptions
            );
            const success = targetResult.success;
            switch (target.name) {
                case 'Git configuration':
                    results.gitSuccess = success;
                    results.gitOutcome = targetResult.outcome;
                    break;
                case 'VSCode configuration':
                    results.vscodeSuccess = success;
                    results.vscodeOutcome = targetResult.outcome;
                    break;
                case 'npm configuration':
                    results.npmSuccess = success;
                    results.npmOutcome = targetResult.outcome;
                    break;
                case 'pip configuration':
                    results.pipSuccess = success;
                    results.pipOutcome = targetResult.outcome;
                    break;
                case 'Terminal environment':
                    results.terminalEnvSuccess = success;
                    results.terminalEnvOutcome = targetResult.outcome;
                    break;
                default:
                    break;
            }
        }

        return results;
    }

    private async updateTarget(
        target: ProxyConfigTarget,
        enabled: boolean,
        proxyUrl: string,
        errorAggregator: ErrorAggregator,
        reportStatus?: ProxyConfigStatusReporter,
        applyOptions?: ProxyApplyOptions
    ): Promise<ProxyConfigTargetUpdateResult> {
        const options = { onStatus: reportStatus };
        if (!enabled && this.ownershipStore && target.ownership) {
            return this.disableOwnedTarget(target, errorAggregator, options);
        }

        const splitTarget = enabled ? this.splitAwareTarget(target, applyOptions) : target;
        const result = await updateProxyConfigTargetDetailed(
            splitTarget,
            enabled,
            proxyUrl,
            errorAggregator,
            options
        );
        if (enabled && this.ownershipStore && target.ownership) {
            if (result.outcome === 'configured') {
                if (target.name === 'npm configuration' && this.isSplitApply(applyOptions)) {
                    await this.markSplitNpmOwned(applyOptions!.httpUrl!, applyOptions!.httpsUrl!);
                } else {
                    await this.markTargetOwned(target, proxyUrl);
                }
            } else if (result.residualKeys && result.residualKeys.length > 0) {
                await this.markResidualOwned(target, proxyUrl, result.residualKeys);
            }
        }
        return result;
    }

    private splitAwareTarget(target: ProxyConfigTarget, applyOptions?: ProxyApplyOptions): ProxyConfigTarget {
        if (!this.isSplitApply(applyOptions)) {
            return target;
        }

        if (target.name === 'npm configuration') {
            return {
                ...target,
                manager: {
                    setProxy: () => this.npmManager.setProxyKeys({
                        proxy: applyOptions!.httpUrl!,
                        'https-proxy': applyOptions!.httpsUrl!
                    }),
                    unsetProxy: options => target.manager.unsetProxy(options)
                }
            };
        }

        if (target.name === 'Terminal environment' && this.terminalEnvManager) {
            return {
                ...target,
                manager: {
                    setProxy: () => this.terminalEnvManager!.setProxyByScheme(
                        applyOptions!.httpUrl!,
                        applyOptions!.httpsUrl!
                    ),
                    unsetProxy: options => target.manager.unsetProxy(options)
                }
            };
        }

        return target;
    }

    private async markSplitNpmOwned(httpUrl: string, httpsUrl: string): Promise<void> {
        const httpPublic = removeProxyCredentials(httpUrl) || httpUrl;
        const httpsPublic = removeProxyCredentials(httpsUrl) || httpsUrl;
        await this.ownershipStore!.bootstrapFromSnapshot(httpPublic, [{
            targetId: 'npm.user.proxy',
            targetHost: 'workspaceHost',
            value: httpPublic
        }], httpUrl);
        await this.ownershipStore!.bootstrapFromSnapshot(httpsPublic, [{
            targetId: 'npm.user.https-proxy',
            targetHost: 'workspaceHost',
            value: httpsPublic
        }], httpsUrl);
    }

    private async markTargetOwned(target: ProxyConfigTarget, proxyUrl: string): Promise<void> {
        const publicUrl = removeProxyCredentials(proxyUrl) || proxyUrl;
        const applyIds = new Set(
            target.ownership!.applyTargetIds ?? target.ownership!.targets.map(entry => entry.targetId)
        );
        await this.ownershipStore!.bootstrapFromSnapshot(
            publicUrl,
            target.ownership!.targets
                .filter(entry => applyIds.has(entry.targetId))
                .map(entry => ({
                    targetId: entry.targetId,
                    targetHost: entry.targetHost,
                    value: publicUrl
                })),
            proxyUrl
        );
    }

    private residualTargetMatches(targetId: string, residualKeys: readonly string[]): boolean {
        return residualKeys.some(key => targetId.endsWith(`.${key}`));
    }

    private async markResidualOwned(
        target: ProxyConfigTarget,
        proxyUrl: string,
        residualKeys: readonly string[]
    ): Promise<void> {
        const publicUrl = removeProxyCredentials(proxyUrl) || proxyUrl;
        let inspection: ProxyOwnershipInspection;
        try {
            inspection = await target.ownership!.inspect();
        } catch {
            Logger.warn(`${target.name} residual ownership skipped: inspect failed after partial write`);
            return;
        }
        if (inspection.status !== 'available' || !inspection.observations) {
            Logger.warn(`${target.name} residual ownership skipped: ${inspection.error || 'inspect unavailable'}`);
            return;
        }

        const snapshots = inspection.observations
            .filter(observation => this.residualTargetMatches(observation.targetId, residualKeys))
            .filter(observation => observation.value === proxyUrl || observation.value === publicUrl)
            .map(observation => {
                const host = target.ownership!.targets.find(entry => entry.targetId === observation.targetId)?.targetHost
                    ?? 'workspaceHost';
                return {
                    targetId: observation.targetId,
                    targetHost: host,
                    value: publicUrl
                };
            });

        if (snapshots.length === 0) {
            return;
        }

        await this.ownershipStore!.bootstrapFromSnapshot(publicUrl, snapshots, proxyUrl);
        Logger.warn(`${target.name} recorded ownership for residual keys: ${residualKeys.join(', ')}`);
    }

    private async disableOwnedTarget(
        target: ProxyConfigTarget,
        errorAggregator: ErrorAggregator,
        options: { onStatus?: ProxyConfigStatusReporter }
    ): Promise<ProxyConfigTargetUpdateResult> {
        let inspection: ProxyOwnershipInspection;
        try {
            inspection = await target.ownership!.inspect();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errorAggregator.addError(target.name, message);
            return { success: false, outcome: 'failed' };
        }

        if (inspection.status === 'unavailable') {
            Logger.info(`${target.name} cleanup skipped:`, inspection.error);
            return { success: true, outcome: 'skippedUnavailable', errorType: inspection.errorType };
        }
        if (inspection.status === 'error') {
            errorAggregator.addError(target.name, inspection.error || `Failed to inspect ${target.name}`, inspection.errorType);
            return { success: false, outcome: 'failed', errorType: inspection.errorType };
        }

        // Re-inspect + value-aware unset close the check-then-key-unset window.
        // Locks cannot serialize `git config` / `npm config` / settings.json
        // writers outside this process.
        const firstPass = await this.classifyOwnedObservations(target.name, inspection.observations ?? []);
        if (firstPass.owned.length === 0) {
            return {
                success: true,
                outcome: firstPass.preservedExternal ? 'preservedExternal' : 'cleared'
            };
        }

        let confirmation: ProxyOwnershipInspection;
        try {
            confirmation = await target.ownership!.inspect();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errorAggregator.addError(target.name, message);
            return { success: false, outcome: 'failed' };
        }
        if (confirmation.status === 'unavailable') {
            Logger.info(`${target.name} cleanup skipped:`, confirmation.error);
            return { success: true, outcome: 'skippedUnavailable', errorType: confirmation.errorType };
        }
        if (confirmation.status === 'error') {
            errorAggregator.addError(
                target.name,
                confirmation.error || `Failed to re-inspect ${target.name}`,
                confirmation.errorType
            );
            return { success: false, outcome: 'failed', errorType: confirmation.errorType };
        }

        const confirmed = await this.classifyOwnedObservations(target.name, confirmation.observations ?? []);
        const preservedExternal = firstPass.preservedExternal || confirmed.preservedExternal;
        if (confirmed.owned.length === 0) {
            return {
                success: true,
                outcome: preservedExternal ? 'preservedExternal' : 'cleared'
            };
        }

        try {
            const result = await target.ownership!.unsetTargets(confirmed.owned, options);
            if (!result.success) {
                errorAggregator.addError(target.name, result.error || `Failed to clear ${target.name}`, result.errorType);
                return { success: false, outcome: 'failed', errorType: result.errorType };
            }

            let after: ProxyOwnershipInspection;
            try {
                after = await target.ownership!.inspect();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errorAggregator.addError(target.name, message);
                return { success: false, outcome: 'failed' };
            }
            if (after.status === 'error') {
                errorAggregator.addError(
                    target.name,
                    after.error || `Failed to verify ${target.name} after unset`,
                    after.errorType
                );
                return { success: false, outcome: 'failed', errorType: after.errorType };
            }

            let stillPreserved = preservedExternal || (result.preservedKeys?.length ?? 0) > 0;
            if (after.status === 'available') {
                const afterPass = await this.classifyOwnedObservations(
                    target.name,
                    after.observations ?? [],
                    { logPreserve: false }
                );
                if (afterPass.owned.length > 0) {
                    errorAggregator.addError(target.name, `Owned ${target.name} value remained after unset`);
                    return { success: false, outcome: 'failed' };
                }
                stillPreserved = stillPreserved || afterPass.preservedExternal;
                for (const request of confirmed.owned) {
                    const remaining = after.observations?.find(observation => observation.targetId === request.targetId);
                    if (!remaining?.value) {
                        await this.ownershipStore!.remove(request.targetId);
                    }
                }
            }

            return {
                success: true,
                outcome: stillPreserved ? 'preservedExternal' : 'cleared'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errorAggregator.addError(target.name, message);
            return { success: false, outcome: 'failed' };
        }
    }

    private async classifyOwnedObservations(
        targetName: string,
        observations: readonly ProxyOwnershipObservation[],
        options: { logPreserve?: boolean } = {}
    ): Promise<{ owned: OwnedTargetUnsetRequest[]; preservedExternal: boolean }> {
        const owned: OwnedTargetUnsetRequest[] = [];
        let preservedExternal = false;
        const logPreserve = options.logPreserve !== false;
        for (const observation of observations) {
            if (!observation.value) {
                // An absent value is converged. Drop stale ownership so a future
                // external value equal to an old proxy cannot be deleted by mistake.
                await this.ownershipStore!.remove(observation.targetId);
                continue;
            }

            const isOwned = await this.ownershipStore!.isOwnedByOtakProxy(
                observation.targetId,
                observation.value,
                hasProxyCredentials(observation.value)
            );
            if (isOwned) {
                owned.push({ targetId: observation.targetId, expectedValue: observation.value });
            } else {
                preservedExternal = true;
                if (logPreserve) {
                    Logger.info(`${targetName} value preserved because ownership did not match: ${observation.targetId}`);
                }
            }
        }
        return { owned, preservedExternal };
    }

    private getApplyTargets(): ProxyConfigTarget[] {
        const targets: ProxyConfigTarget[] = [
            this.vscodeTarget(),
            this.gitTarget(),
            this.npmTarget()
        ];

        if (this.pipManager) {
            targets.push(this.pipTarget());
        }

        if (this.terminalEnvManager) {
            targets.push({ name: 'Terminal environment', manager: this.terminalEnvManager });
        }

        return targets;
    }

    private getDisableTargets(): ProxyConfigTarget[] {
        const targets: ProxyConfigTarget[] = [
            this.gitTarget(),
            this.vscodeTarget(),
            this.npmTarget()
        ];

        if (this.pipManager) {
            targets.push(this.pipTarget());
        }

        if (this.terminalEnvManager) {
            targets.push({ name: 'Terminal environment', manager: this.terminalEnvManager });
        }

        return targets;
    }

    private gitTarget(): ProxyConfigTarget {
        const ids: Record<GitProxyKey, string> = {
            'http.proxy': 'git.global.http.proxy',
            'https.proxy': 'git.global.https.proxy'
        };
        return {
            name: 'Git configuration',
            manager: this.gitManager,
            ownership: {
                targets: Object.values(ids).map(targetId => ({ targetId, targetHost: 'workspaceHost' })),
                applyTargetIds: [ids['http.proxy']],
                inspect: async () => {
                    const result = await this.gitManager.inspectProxy();
                    const keys = Object.keys(ids) as GitProxyKey[];
                    return {
                        status: result.status,
                        error: result.error,
                        errorType: result.errorType,
                        observations: result.values || result.allValues
                            ? keys.flatMap(key => {
                                const listed = result.allValues?.[key];
                                if (listed && listed.length > 0) {
                                    return listed.map(value => ({ targetId: ids[key], value }));
                                }
                                return [{ targetId: ids[key], value: result.values?.[key] ?? null }];
                            })
                            : undefined
                    };
                },
                unsetTargets: (owned, options) => {
                    const exactValues: Partial<Record<GitProxyKey, string[]>> = {};
                    const expectedValues: Partial<Record<GitProxyKey, string>> = {};
                    for (const request of owned) {
                        const key = (Object.keys(ids) as GitProxyKey[]).find(candidate => ids[candidate] === request.targetId);
                        if (!key) {
                            continue;
                        }
                        exactValues[key] = [...(exactValues[key] ?? []), request.expectedValue];
                        expectedValues[key] = request.expectedValue;
                    }
                    return this.gitManager.unsetProxyKeys(
                        (Object.keys(ids) as GitProxyKey[]).filter(key => key in expectedValues),
                        {
                            onStatus: options?.onStatus,
                            exactValues: Object.keys(exactValues).length > 0 ? exactValues : undefined,
                            expectedValues
                        }
                    );
                }
            }
        };
    }

    private npmTarget(): ProxyConfigTarget {
        const ids: Record<NpmProxyKey, string> = {
            proxy: 'npm.user.proxy',
            'https-proxy': 'npm.user.https-proxy'
        };
        return {
            name: 'npm configuration',
            manager: this.npmManager,
            ownership: {
                targets: Object.values(ids).map(targetId => ({ targetId, targetHost: 'workspaceHost' })),
                inspect: async () => {
                    const result = await this.npmManager.inspectProxy();
                    return {
                        status: result.status,
                        error: result.error,
                        errorType: result.errorType,
                        observations: result.values
                            ? (Object.keys(ids) as NpmProxyKey[]).map(key => ({ targetId: ids[key], value: result.values![key] }))
                            : undefined
                    };
                },
                unsetTargets: owned => {
                    const expectedValues: Partial<Record<NpmProxyKey, string>> = {};
                    for (const request of owned) {
                        const key = (Object.keys(ids) as NpmProxyKey[]).find(candidate => ids[candidate] === request.targetId);
                        if (key) {
                            expectedValues[key] = request.expectedValue;
                        }
                    }
                    return this.npmManager.unsetProxyKeys(
                        (Object.keys(ids) as NpmProxyKey[]).filter(key => key in expectedValues),
                        expectedValues
                    );
                }
            }
        };
    }

    private vscodeTarget(): ProxyConfigTarget {
        const targetId = 'vscode.http.proxy';
        return {
            name: 'VSCode configuration',
            manager: this.vscodeManager,
            ownership: {
                targets: [{ targetId, targetHost: 'workspaceHost' }],
                inspect: async () => {
                    const result = await this.vscodeManager.inspectProxy();
                    return {
                        status: result.status,
                        error: result.error,
                        errorType: result.errorType,
                        observations: result.values ? [{ targetId, value: result.values.proxy }] : undefined
                    };
                },
                unsetTargets: owned => this.vscodeManager.unsetProxy({ expectedValue: owned[0]?.expectedValue })
            }
        };
    }

    private pipTarget(): ProxyConfigTarget {
        const targetId = 'pip.user.global.proxy';
        return {
            name: 'pip configuration',
            manager: this.pipManager!,
            ownership: {
                targets: [{ targetId, targetHost: 'workspaceHost' }],
                inspect: async () => {
                    const result = await this.pipManager!.inspectProxy();
                    return {
                        status: result.status,
                        error: result.error,
                        errorType: result.errorType,
                        observations: result.values ? [{ targetId, value: result.values.proxy }] : undefined
                    };
                },
                unsetTargets: owned => this.pipManager!.unsetProxy({ expectedValue: owned[0]?.expectedValue })
            }
        };
    }
}
