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
   * Formats all errors into user-friendly message with structured output
   * @returns Formatted error message with troubleshooting steps
   */
  formatErrors(): string {
    if (!this.hasErrors()) {
      return '';
    }

    const errorCount = this.errors.size;
    const operations = Array.from(this.errors.keys());
    
    let message = errorCount === 1 
      ? `Operation failed: ${operations[0]}\n\n`
      : `Multiple operations failed (${errorCount} errors)\n\n`;

    message += 'What happened:\n';
    for (const [operation, error] of this.errors) {
      message += `- ${operation}: ${error}\n`;
    }

    message += '\nSuggestions:\n';
    message += this.generateSuggestions();

    return message;
  }

  /**
   * Clears all collected errors
   */
  clear(): void {
    this.errors.clear();
  }

  /**
   * Generates troubleshooting suggestions based on collected errors
   * @returns Formatted suggestions string
   */
  private generateSuggestions(): string {
    const suggestions: string[] = [];
    const operations = Array.from(this.errors.keys());
    const errorMessages = Array.from(this.errors.values());

    // Git-related suggestions
    if (operations.some(op => op.toLowerCase().includes('git'))) {
      const lockError = errorMessages.find(err =>
        err.toLowerCase().includes('could not lock config file') ||
        err.toLowerCase().includes('git config file is locked')
      );
      const gitError = errorMessages.find(err => 
        err.toLowerCase().includes('not found') || 
        err.toLowerCase().includes('not installed')
      );
      if (gitError) {
        suggestions.push('Install Git from https://git-scm.com');
        suggestions.push('Ensure Git is added to your system PATH');
        suggestions.push('Restart VSCode after installing Git');
      } else if (lockError) {
        suggestions.push('Close other VSCode windows and Git processes, then try again');
        suggestions.push('If a stale lock file exists, delete the global Git config lock (e.g., ~/.gitconfig.lock or %USERPROFILE%\\.gitconfig.lock)');
        suggestions.push('Retry the operation after removing the lock file');
      } else {
        suggestions.push('Check Git installation and permissions');
        suggestions.push('Try running Git commands manually in terminal');
      }
    }

    // VSCode configuration suggestions
    if (operations.some(op => op.toLowerCase().includes('vscode'))) {
      suggestions.push('Check VSCode settings permissions');
      suggestions.push('Try restarting VSCode');
    }

    // npm-related suggestions
    if (operations.some(op => op.toLowerCase().includes('npm'))) {
      const npmError = errorMessages.find(err =>
        err.toLowerCase().includes('not found') ||
        err.toLowerCase().includes('not installed') ||
        err.toLowerCase().includes('enoent')
      );
      if (npmError) {
        suggestions.push('Install Node.js and npm from https://nodejs.org/');
        suggestions.push('Verify npm is in your system PATH');
        suggestions.push('Restart VSCode after installing npm');
      } else if (errorMessages.some(err => err.toLowerCase().includes('permission'))) {
        suggestions.push('Check file permissions for npm config files');
        suggestions.push('Try running VSCode with appropriate permissions');
        suggestions.push('Verify you have write access to npm\'s global config');
      } else if (errorMessages.some(err => err.toLowerCase().includes('timeout') || err.toLowerCase().includes('timed out'))) {
        suggestions.push('Check if npm is responding correctly');
        suggestions.push('Try running \'npm config list\' manually to verify npm works');
        suggestions.push('Restart VSCode and try again');
      } else if (errorMessages.some(err => err.toLowerCase().includes('config'))) {
        suggestions.push('Verify npm configuration is not corrupted');
        suggestions.push('Try running \'npm config list\' to check npm config');
        suggestions.push('Consider resetting npm config with \'npm config edit\'');
      } else {
        suggestions.push('Check npm installation and configuration');
        suggestions.push('Try running npm commands manually to diagnose the issue');
      }
    }

    // System proxy detection suggestions
    if (operations.some(op => op.toLowerCase().includes('system') || op.toLowerCase().includes('detect'))) {
      suggestions.push('Manually enter proxy URL instead of auto-detection');
      suggestions.push('Check system proxy settings in your OS');
    }

    // Connection/network suggestions
    if (errorMessages.some(err => 
      err.toLowerCase().includes('connection') || 
      err.toLowerCase().includes('timeout') ||
      err.toLowerCase().includes('network')
    )) {
      suggestions.push('Verify proxy URL is correct');
      suggestions.push('Check network connectivity');
      suggestions.push('Ensure proxy server is accessible');
    }

    // Permission suggestions
    if (errorMessages.some(err => 
      err.toLowerCase().includes('permission') || 
      err.toLowerCase().includes('access denied')
    )) {
      suggestions.push('Check file and directory permissions');
      suggestions.push('Try running VSCode with appropriate permissions');
    }

    // Default suggestion if no specific ones were added
    if (suggestions.length === 0) {
      suggestions.push('Check the error details above for specific issues');
      suggestions.push('Try the operation again');
      suggestions.push('Restart VSCode if the problem persists');
    }

    return suggestions.map(s => `- ${s}`).join('\n');
  }
}
