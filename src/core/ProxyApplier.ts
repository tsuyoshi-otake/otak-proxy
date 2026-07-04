import * as vscode from 'vscode';
import { GitConfigManager } from '../config/GitConfigManager';
import { VscodeConfigManager } from '../config/VscodeConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
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
    ProxyConfigTarget
} from './ProxyApplierTypes';
import { updateProxyConfigTarget } from './ProxyConfigTargetRunner';
import { saveProxyConfigResults } from './ProxyConfigStateTracker';
import { buildProxyValidationSuggestions } from './ProxyValidationMessages';
import {
    showAggregatedErrors,
    showProxyConfigured,
    showProxyDisabled
} from './ProxyApplierNotifications';

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
        private terminalEnvManager?: TerminalEnvConfigManager
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
            results.terminalEnvSuccess;
    }

    private notifyApplyResult(
        proxyUrl: string,
        options: ProxyApplyOptions | undefined,
        errorAggregator: ErrorAggregator
    ): void {
        if (errorAggregator.hasErrors()) {
            showAggregatedErrors(errorAggregator, this.userNotifier);
            return;
        }

        if (!options?.silent) {
            showProxyConfigured(proxyUrl, this.sanitizer, this.userNotifier);
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
        
        // Requirement 1.1, 1.3, 1.4, 3.1: Validate proxy URL before any configuration
        if (proxyUrl && !this.validateProxyUrlForApply(proxyUrl)) {
            return this.buildDetailedResult(false, true, proxyUrl, this.emptyResults(), errorAggregator);
        }
        
        const results = await this.withOptionalProgress(
            options,
            async reportStatus => this.updateTargets(
                this.getApplyTargets(),
                true,
                proxyUrl,
                errorAggregator,
                reportStatus
            )
        );

        // Track configuration state if stateManager is provided
        await saveProxyConfigResults(this.stateManager, true, results, errorAggregator);

        const success = this.areConfigResultsSuccessful(results);
        
        // Requirement 2.5: Use ErrorAggregator to display all errors together
        this.notifyApplyResult(proxyUrl, options, errorAggregator);

        return this.buildDetailedResult(success, true, proxyUrl, results, errorAggregator);
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
            terminalEnvSuccess: false
        };
    }

    private buildDetailedResult(
        success: boolean,
        enabled: boolean,
        proxyUrl: string,
        results: ProxyConfigResults,
        errorAggregator: ErrorAggregator
    ): ProxyApplyDetailedResult {
        return {
            success,
            enabled,
            proxyUrl: this.sanitizer.maskPassword(proxyUrl),
            results,
            errors: errorAggregator.getErrors().map(error => ({
                target: error.operation,
                message: this.sanitizer.maskPassword(error.error)
            }))
        };
    }

    private async updateTargets(
        targets: ProxyConfigTarget[],
        enabled: boolean,
        proxyUrl: string,
        errorAggregator: ErrorAggregator,
        reportStatus?: ProxyConfigStatusReporter
    ): Promise<ProxyConfigResults> {
        const results: ProxyConfigResults = {
            gitSuccess: false,
            vscodeSuccess: false,
            npmSuccess: false,
            terminalEnvSuccess: true
        };

        for (const target of targets) {
            reportStatus?.(this.getTargetProgressKey(target, enabled));
            const success = await updateProxyConfigTarget(target, enabled, proxyUrl, errorAggregator, {
                onStatus: reportStatus
            });
            switch (target.name) {
                case 'Git configuration':
                    results.gitSuccess = success;
                    break;
                case 'VSCode configuration':
                    results.vscodeSuccess = success;
                    break;
                case 'npm configuration':
                    results.npmSuccess = success;
                    break;
                case 'Terminal environment':
                    results.terminalEnvSuccess = success;
                    break;
                default:
                    break;
            }
        }

        return results;
    }

    private getApplyTargets(): ProxyConfigTarget[] {
        const targets: ProxyConfigTarget[] = [
            { name: 'VSCode configuration', manager: this.vscodeManager },
            { name: 'Git configuration', manager: this.gitManager },
            { name: 'npm configuration', manager: this.npmManager }
        ];

        if (this.terminalEnvManager) {
            targets.push({ name: 'Terminal environment', manager: this.terminalEnvManager });
        }

        return targets;
    }

    private getDisableTargets(): ProxyConfigTarget[] {
        const targets: ProxyConfigTarget[] = [
            { name: 'Git configuration', manager: this.gitManager },
            { name: 'VSCode configuration', manager: this.vscodeManager },
            { name: 'npm configuration', manager: this.npmManager }
        ];

        if (this.terminalEnvManager) {
            targets.push({ name: 'Terminal environment', manager: this.terminalEnvManager });
        }

        return targets;
    }
}
