import * as vscode from 'vscode';
import { GitConfigManager } from '../config/GitConfigManager';
import { VscodeConfigManager } from '../config/VscodeConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { UserNotifier } from '../errors/UserNotifier';
import { ErrorAggregator } from '../errors/ErrorAggregator';
import { Logger } from '../utils/Logger';
import { ProxyStateManager } from './ProxyStateManager';

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

    /**
     * Apply proxy settings to all configuration targets
     * 
     * @param proxyUrl - The proxy URL to apply
     * @param enabled - Whether to enable or disable the proxy
     * @returns Promise<boolean> - True if all operations succeeded
     */
    async applyProxy(proxyUrl: string, enabled: boolean): Promise<boolean> {
        const errorAggregator = new ErrorAggregator();
        
        // Edge Case 1: Handle empty URL as disable proxy (Requirement 4.1)
        if (!proxyUrl || proxyUrl.trim() === '') {
            enabled = false;
        }
        
        // If disabling, use the dedicated disable function
        if (!enabled) {
            return await this.disableProxy();
        }
        
        // Requirement 1.1, 1.3, 1.4, 3.1: Validate proxy URL before any configuration
        if (proxyUrl) {
            const validationResult = this.validator.validate(proxyUrl);
            if (!validationResult.isValid) {
                // Display validation errors with specific details
                const errorMessage = 'Invalid proxy URL format';
                const suggestions = validationResult.errors.map(err => err);
                suggestions.push('Use format: http://proxy.example.com:8080');
                suggestions.push('Include protocol (http:// or https://)');
                suggestions.push('Ensure hostname contains only alphanumeric characters, dots, and hyphens');
                
                this.userNotifier.showError(errorMessage, suggestions);
                return false;
            }
        }
        
        let gitSuccess = false;
        let vscodeSuccess = false;
        let npmSuccess = false;
        let terminalEnvSuccess = true;

        // Requirement 2.2: Try VSCode configuration, continue on failure
        vscodeSuccess = await this.updateManager(
            this.vscodeManager,
            'VSCode configuration',
            enabled,
            proxyUrl,
            errorAggregator
        );

        // Try Git configuration
        gitSuccess = await this.updateManager(
            this.gitManager,
            'Git configuration',
            enabled,
            proxyUrl,
            errorAggregator
        );

        // Try npm configuration
        npmSuccess = await this.updateManager(
            this.npmManager,
            'npm configuration',
            enabled,
            proxyUrl,
            errorAggregator
        );

        // Try VSCode integrated terminal environment variables (best-effort)
        if (this.terminalEnvManager) {
            terminalEnvSuccess = await this.updateManager(
                this.terminalEnvManager,
                'Terminal environment',
                enabled,
                proxyUrl,
                errorAggregator
            );
        }

        // Track configuration state if stateManager is provided
        if (this.stateManager) {
            try {
                const state = await this.stateManager.getState();
                state.gitConfigured = gitSuccess;
                state.vscodeConfigured = vscodeSuccess;
                state.npmConfigured = npmSuccess;
                state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
                await this.stateManager.saveState(state);
            } catch (error) {
                // Requirement 4.4: If we can't save state, log but don't fail the operation
                Logger.error('Failed to update configuration state tracking:', error);
            }
        }

        const success = gitSuccess && vscodeSuccess && npmSuccess && terminalEnvSuccess;
        
        // Requirement 2.5: Use ErrorAggregator to display all errors together
        if (errorAggregator.hasErrors()) {
            const formattedErrors = errorAggregator.formatErrors();
            // Parse the formatted error message to extract suggestions
            const lines = formattedErrors.split('\n');
            const suggestionStartIndex = lines.findIndex(line => line.includes('Suggestions:'));
            const suggestions = suggestionStartIndex >= 0 
                ? lines.slice(suggestionStartIndex + 1).filter(line => line.trim().startsWith('-')).map(line => line.trim().substring(2))
                : [];
            
            const errorMessage = lines.slice(0, suggestionStartIndex >= 0 ? suggestionStartIndex : lines.length).join('\n');
            this.userNotifier.showError(errorMessage, suggestions);
        } else if (proxyUrl) {
            // Requirement 1.5, 6.2: Update status bar with sanitized proxy URL
            const sanitizedUrl = this.sanitizer.maskPassword(proxyUrl);
            this.userNotifier.showSuccess('message.proxyConfigured', { url: sanitizedUrl });
        }

        return success;
    }

    /**
     * Disable proxy settings across all configuration targets
     * Requirement 2.5: Use ErrorAggregator and UserNotifier for comprehensive error handling
     * 
     * @returns Promise<boolean> - True if all operations succeeded
     */
    async disableProxy(): Promise<boolean> {
        const errorAggregator = new ErrorAggregator();
        
        let gitSuccess = false;
        let vscodeSuccess = false;
        let npmSuccess = false;
        let terminalEnvSuccess = true;

        // Use GitConfigManager.unsetProxy()
        try {
            const result = await this.gitManager.unsetProxy();
            if (!result.success) {
                errorAggregator.addError('Git configuration', result.error || 'Failed to unset Git proxy');
            } else {
                gitSuccess = true;
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            errorAggregator.addError('Git configuration', errorMsg);
        }

        // Use VscodeConfigManager.unsetProxy()
        try {
            const result = await this.vscodeManager.unsetProxy();
            if (!result.success) {
                errorAggregator.addError('VSCode configuration', result.error || 'Failed to unset VSCode proxy');
            } else {
                vscodeSuccess = true;
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            errorAggregator.addError('VSCode configuration', errorMsg);
        }

        // Use NpmConfigManager.unsetProxy()
        try {
            const result = await this.npmManager.unsetProxy();
            if (!result.success) {
                errorAggregator.addError('npm configuration', result.error || 'Failed to unset npm proxy');
            } else {
                npmSuccess = true;
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            errorAggregator.addError('npm configuration', errorMsg);
        }

        // Use TerminalEnvConfigManager.unsetProxy() (best-effort)
        if (this.terminalEnvManager) {
            try {
                const result = await this.terminalEnvManager.unsetProxy();
                if (!result.success) {
                    errorAggregator.addError('Terminal environment', result.error || 'Failed to unset terminal proxy env');
                    terminalEnvSuccess = false;
                } else {
                    terminalEnvSuccess = true;
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                errorAggregator.addError('Terminal environment', errorMsg);
                terminalEnvSuccess = false;
            }
        }

        // Track configuration state if stateManager is provided
        if (this.stateManager) {
            try {
                const state = await this.stateManager.getState();
                state.gitConfigured = false;
                state.vscodeConfigured = false;
                state.npmConfigured = false;
                state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
                await this.stateManager.saveState(state);
            } catch (error) {
                Logger.error('Failed to update configuration state tracking:', error);
            }
        }

        const success = gitSuccess && vscodeSuccess && npmSuccess && terminalEnvSuccess;
        
        // Use ErrorAggregator for any failures and UserNotifier for feedback
        if (errorAggregator.hasErrors()) {
            const formattedErrors = errorAggregator.formatErrors();
            const lines = formattedErrors.split('\n');
            const suggestionStartIndex = lines.findIndex(line => line.includes('Suggestions:'));
            const suggestions = suggestionStartIndex >= 0 
                ? lines.slice(suggestionStartIndex + 1).filter(line => line.trim().startsWith('-')).map(line => line.trim().substring(2))
                : [];
            
            const errorMessage = lines.slice(0, suggestionStartIndex >= 0 ? suggestionStartIndex : lines.length).join('\n');
            this.userNotifier.showError(errorMessage, suggestions);
        } else {
            // Update status bar to show proxy disabled
            this.userNotifier.showSuccess('message.proxyDisabled');
        }

        return success;
    }

    /**
     * Update a single ConfigManager with error handling
     * 
     * @param manager - The ConfigManager to update
     * @param name - The name of the manager for error reporting
     * @param enabled - Whether to enable or disable the proxy
     * @param proxyUrl - The proxy URL to apply
     * @param errorAggregator - The ErrorAggregator to collect errors
     * @returns Promise<boolean> - True if the operation succeeded
     */
    private async updateManager(
        manager: GitConfigManager | VscodeConfigManager | NpmConfigManager | TerminalEnvConfigManager,
        name: string,
        enabled: boolean,
        proxyUrl: string,
        errorAggregator: ErrorAggregator
    ): Promise<boolean> {
        try {
            let result;
            
            if (enabled) {
                result = await manager.setProxy(proxyUrl);
            } else {
                result = await manager.unsetProxy();
            }

            if (!result.success) {
                // Log the error with details
                Logger.error(`${name} failed:`, result.error, result.errorType);
                
                // Add to error aggregator
                errorAggregator.addError(name, result.error || `Failed to update ${name}`);
                return false;
            }

            return true;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`${name} error:`, error);
            errorAggregator.addError(name, errorMsg);
            return false;
        }
    }
}
