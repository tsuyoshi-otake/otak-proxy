import { I18nManager } from '../i18n/I18nManager';

export interface AggregatedErrorDisplayParts {
  message: string;
  suggestions: string[];
}

/**
 * ErrorAggregator collects and formats multiple errors from configuration operations.
 * This allows the extension to attempt multiple operations and report all failures
 * together with context, rather than stopping at the first error.
 */
export class ErrorAggregator {
  private errors: Map<string, string> = new Map();

  /**
   * Adds an error to the collection
   * @param operation - Which operation failed (e.g., "Git configuration", "VSCode configuration")
   * @param error - Error details
   */
  addError(operation: string, error: string): void {
    this.errors.set(operation, error);
  }

  /**
   * Checks if any errors were collected
   * @returns true if errors exist
   */
  hasErrors(): boolean {
    return this.errors.size > 0;
  }

  /**
   * Formats all errors into user-friendly message with structured output.
   * @returns Formatted error message with troubleshooting steps
   */
  formatErrors(): string {
    const parts = this.getDisplayParts();
    if (!parts.message) {
      return '';
    }

    if (parts.suggestions.length === 0) {
      return parts.message;
    }

    return `${parts.message}\n\n${this.t('label.suggestions', 'Suggestions:')}\n${this.generateSuggestions()}`;
  }

  /**
   * Formats errors as structured display parts so callers do not need to parse
   * localized strings to split the message from suggestions.
   */
  getDisplayParts(): AggregatedErrorDisplayParts {
    if (!this.hasErrors()) {
      return { message: '', suggestions: [] };
    }

    const errorCount = this.errors.size;
    const operations = Array.from(this.errors.keys());
    const messageLines: string[] = [];

    messageLines.push(errorCount === 1
      ? this.t('errorAggregator.singleFailure', 'Operation failed: {operation}', {
        operation: this.localizeOperation(operations[0])
      })
      : this.t('errorAggregator.multipleFailure', 'Multiple operations failed ({count} errors)', {
        count: String(errorCount)
      }));
    messageLines.push('');
    messageLines.push(this.t('errorAggregator.whatHappened', 'What happened:'));

    for (const [operation, error] of this.errors) {
      messageLines.push(`- ${this.localizeOperation(operation)}: ${this.localizeError(error)}`);
    }

    return {
      message: messageLines.join('\n'),
      suggestions: this.generateSuggestionList()
    };
  }

  /**
   * Clears all collected errors
   */
  clear(): void {
    this.errors.clear();
  }

  /**
   * Generates troubleshooting suggestions based on collected errors.
   * @returns Formatted suggestions string
   */
  private generateSuggestions(): string {
    return this.generateSuggestionList().map(s => `- ${s}`).join('\n');
  }

  private generateSuggestionList(): string[] {
    const suggestions: string[] = [];
    const operations = Array.from(this.errors.keys());
    const errorMessages = Array.from(this.errors.values());

    // Git-related suggestions
    if (operations.some(op => op.toLowerCase().includes('git'))) {
      const lockError = errorMessages.find(err =>
        err.toLowerCase().includes('could not lock config file') ||
        err.toLowerCase().includes('git config file is locked') ||
        err.toLowerCase().includes('git configuration is already being updated') ||
        err.toLowerCase().includes('timed out acquiring git config mutex')
      );
      const gitError = errorMessages.find(err =>
        err.toLowerCase().includes('not found') ||
        err.toLowerCase().includes('not installed')
      );
      if (gitError) {
        suggestions.push(this.t('suggestion.git.installGit', 'Install Git from https://git-scm.com'));
        suggestions.push(this.t('suggestion.git.ensurePath', 'Ensure Git is added to your system PATH'));
        suggestions.push(this.t('suggestion.git.restartAfterInstall', 'Restart VS Code after installing Git'));
      } else if (lockError) {
        suggestions.push(this.t('suggestion.git.closeOtherWindows', 'Close other VS Code/Cursor windows and Git processes, then try again'));
        suggestions.push(this.t('suggestion.git.waitAndRetry', 'Wait a few seconds and retry the operation'));
        suggestions.push(this.t('suggestion.git.removeStaleLock', 'If a stale lock file exists, delete the global Git config lock (e.g., ~/.gitconfig.lock or %USERPROFILE%\\.gitconfig.lock)'));
      } else {
        suggestions.push(this.t('suggestion.git.checkInstallationAndPermissions', 'Check Git installation and permissions'));
        suggestions.push(this.t('suggestion.git.tryManualCommands', 'Try running Git commands manually in terminal'));
      }
    }

    // VSCode configuration suggestions
    if (operations.some(op => op.toLowerCase().includes('vscode'))) {
      suggestions.push(this.t('suggestion.vscode.checkSettingsPermissions', 'Check VS Code settings permissions'));
      suggestions.push(this.t('suggestion.vscode.restart', 'Try restarting VS Code'));
    }

    // npm-related suggestions
    if (operations.some(op => op.toLowerCase().includes('npm'))) {
      const npmError = errorMessages.find(err =>
        err.toLowerCase().includes('not found') ||
        err.toLowerCase().includes('not installed') ||
        err.toLowerCase().includes('enoent')
      );
      if (npmError) {
        suggestions.push(this.t('suggestion.npm.installNode', 'Install Node.js and npm from https://nodejs.org/'));
        suggestions.push(this.t('suggestion.npm.verifyPath', 'Verify npm is in your system PATH'));
        suggestions.push(this.t('suggestion.npm.restartAfterInstall', 'Restart VS Code after installing npm'));
      } else if (errorMessages.some(err => err.toLowerCase().includes('permission'))) {
        suggestions.push(this.t('suggestion.npm.checkPermissions', 'Check file permissions for npm config files'));
        suggestions.push(this.t('suggestion.npm.runWithPermissions', 'Try running VS Code with appropriate permissions'));
        suggestions.push(this.t('suggestion.npm.verifyGlobalWrite', 'Verify you have write access to npm\'s global config'));
      } else if (errorMessages.some(err => err.toLowerCase().includes('timeout') || err.toLowerCase().includes('timed out'))) {
        suggestions.push(this.t('suggestion.npm.checkResponding', 'Check if npm is responding correctly'));
        suggestions.push(this.t('suggestion.npm.tryConfigList', 'Try running \'npm config list\' manually to verify npm works'));
        suggestions.push(this.t('suggestion.vscode.restartAndRetry', 'Restart VS Code and try again'));
      } else if (errorMessages.some(err => err.toLowerCase().includes('config'))) {
        suggestions.push(this.t('suggestion.npm.verifyConfig', 'Verify npm configuration is not corrupted'));
        suggestions.push(this.t('suggestion.npm.checkConfigList', 'Try running \'npm config list\' to check npm config'));
        suggestions.push(this.t('suggestion.npm.resetConfig', 'Consider resetting npm config with \'npm config edit\''));
      } else {
        suggestions.push(this.t('suggestion.npm.checkInstallationAndConfig', 'Check npm installation and configuration'));
        suggestions.push(this.t('suggestion.npm.tryManualCommands', 'Try running npm commands manually to diagnose the issue'));
      }
    }

    // System proxy detection suggestions
    if (operations.some(op => op.toLowerCase().includes('system') || op.toLowerCase().includes('detect'))) {
      suggestions.push(this.t('suggestion.proxy.configureManualInstead', 'Manually enter proxy URL instead of auto-detection'));
      suggestions.push(this.t('suggestion.proxy.checkSystemSettings', 'Check system proxy settings in your OS'));
    }

    // Connection/network suggestions
    if (errorMessages.some(err =>
      err.toLowerCase().includes('connection') ||
      err.toLowerCase().includes('timeout') ||
      err.toLowerCase().includes('network')
    )) {
      suggestions.push(this.t('suggestion.verifyUrl', 'Verify proxy URL is correct'));
      suggestions.push(this.t('suggestion.checkConnectivity', 'Check network connectivity'));
      suggestions.push(this.t('suggestion.proxy.ensureServerAccessible', 'Ensure proxy server is accessible'));
    }

    // Permission suggestions
    if (errorMessages.some(err =>
      err.toLowerCase().includes('permission') ||
      err.toLowerCase().includes('access denied')
    )) {
      suggestions.push(this.t('suggestion.permissions.checkFiles', 'Check file and directory permissions'));
      suggestions.push(this.t('suggestion.vscode.runWithPermissions', 'Try running VS Code with appropriate permissions'));
    }

    // Default suggestion if no specific ones were added
    if (suggestions.length === 0) {
      suggestions.push(this.t('suggestion.generic.checkDetails', 'Check the error details above for specific issues'));
      suggestions.push(this.t('suggestion.generic.tryAgain', 'Try the operation again'));
      suggestions.push(this.t('suggestion.vscode.restartIfPersists', 'Restart VS Code if the problem persists'));
    }

    return [...new Set(suggestions)];
  }

  private localizeOperation(operation: string): string {
    try {
      if (I18nManager.getInstance().getCurrentLocale() === 'en') {
        return operation;
      }
    } catch {
      return operation;
    }

    const operationKeys: Record<string, string> = {
      'Git configuration': 'operation.gitConfiguration',
      'VSCode configuration': 'operation.vscodeConfiguration',
      'npm configuration': 'operation.npmConfiguration',
      'Terminal environment': 'operation.terminalEnvironment'
    };

    const key = operationKeys[operation];
    return key ? this.t(key, operation) : operation;
  }

  private localizeError(error: string): string {
    const lower = error.toLowerCase();

    if (lower.includes('git configuration is already being updated') ||
      lower.includes('timed out acquiring git config mutex')) {
      return this.t(
        'error.gitConfigUpdateInProgress',
        'Git configuration is already being updated by another VS Code/Cursor window. Please wait a few seconds and try again.'
      );
    }

    return error;
  }

  private t(key: string, fallback: string, params?: Record<string, string>): string {
    try {
      const message = I18nManager.getInstance().t(key, params);
      if (!message.startsWith('[missing:')) {
        return message;
      }
    } catch {
      // Unit tests may use ErrorAggregator without initializing the extension i18n manager.
    }

    return this.substituteParams(fallback, params);
  }

  private substituteParams(message: string, params?: Record<string, string>): string {
    if (!params) {
      return message;
    }

    let result = message;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }
}
