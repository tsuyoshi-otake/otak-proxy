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
    ProxyOwnershipInspection
} from './ProxyApplierTypes';
import { updateProxyConfigTargetDetailed } from './ProxyConfigTargetRunner';
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
        await saveProxyConfigResults(this.stateManager, true, results, errorAggregator);

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
        await saveProxyConfigResults(this.stateManager, false, results, errorAggregator);

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
        if (enabled && result.outcome === 'configured' && this.ownershipStore && target.ownership) {
            if (target.name === 'npm configuration' && this.isSplitApply(applyOptions)) {
                await this.markSplitNpmOwned(applyOptions!.httpUrl!, applyOptions!.httpsUrl!);
            } else {
                await this.markTargetOwned(target, proxyUrl);
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
        await this.ownershipStore!.bootstrapFromSnapshot(
            publicUrl,
            target.ownership!.targets.map(entry => ({
                targetId: entry.targetId,
                targetHost: entry.targetHost,
                value: publicUrl
            })),
            proxyUrl
        );
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

        const ownedTargetIds: string[] = [];
        let preservedExternal = false;
        for (const observation of inspection.observations ?? []) {
            if (!observation.value) {
                // An absent value is converged. Drop stale ownership so a future
                // external value equal to an old proxy cannot be deleted by mistake.
                await this.ownershipStore!.remove(observation.targetId);
                continue;
            }

            const owned = await this.ownershipStore!.isOwnedByOtakProxy(
                observation.targetId,
                observation.value,
                hasProxyCredentials(observation.value)
            );
            if (owned) {
                ownedTargetIds.push(observation.targetId);
            } else {
                preservedExternal = true;
                Logger.info(`${target.name} value preserved because ownership did not match: ${observation.targetId}`);
            }
        }

        if (ownedTargetIds.length === 0) {
            return {
                success: true,
                outcome: preservedExternal ? 'preservedExternal' : 'cleared'
            };
        }

        try {
            const result = await target.ownership!.unsetTargets(ownedTargetIds, options);
            if (!result.success) {
                errorAggregator.addError(target.name, result.error || `Failed to clear ${target.name}`, result.errorType);
                return { success: false, outcome: 'failed', errorType: result.errorType };
            }
            for (const targetId of ownedTargetIds) {
                await this.ownershipStore!.remove(targetId);
            }
            return {
                success: true,
                outcome: preservedExternal ? 'preservedExternal' : 'cleared'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errorAggregator.addError(target.name, message);
            return { success: false, outcome: 'failed' };
        }
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
                inspect: async () => {
                    const result = await this.gitManager.inspectProxy();
                    return {
                        status: result.status,
                        error: result.error,
                        errorType: result.errorType,
                        observations: result.values
                            ? (Object.keys(ids) as GitProxyKey[]).map(key => ({ targetId: ids[key], value: result.values![key] }))
                            : undefined
                    };
                },
                unsetTargets: (targetIds, options) => this.gitManager.unsetProxyKeys(
                    (Object.keys(ids) as GitProxyKey[]).filter(key => targetIds.includes(ids[key])),
                    options
                )
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
                unsetTargets: targetIds => this.npmManager.unsetProxyKeys(
                    (Object.keys(ids) as NpmProxyKey[]).filter(key => targetIds.includes(ids[key]))
                )
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
                unsetTargets: () => this.vscodeManager.unsetProxy()
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
                unsetTargets: () => this.pipManager!.unsetProxy()
            }
        };
    }
}
