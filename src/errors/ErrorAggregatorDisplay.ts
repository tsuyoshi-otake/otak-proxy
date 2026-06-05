import { I18nManager } from '../i18n/I18nManager';

export interface AggregatedErrorDisplayParts {
  message: string;
  suggestions: string[];
}

export function getAggregatedErrorDisplayParts(errors: ReadonlyMap<string, string>): AggregatedErrorDisplayParts {
  if (errors.size === 0) {
    return { message: '', suggestions: [] };
  }

  const operations = Array.from(errors.keys());
  const messageLines = buildMessageLines(errors, operations);

  return {
    message: messageLines.join('\n'),
    suggestions: generateSuggestionList(operations, Array.from(errors.values()))
  };
}

export function formatAggregatedErrors(errors: ReadonlyMap<string, string>): string {
  const parts = getAggregatedErrorDisplayParts(errors);
  if (!parts.message) {
    return '';
  }

  if (parts.suggestions.length === 0) {
    return parts.message;
  }

  const suggestions = parts.suggestions.map(s => `- ${s}`).join('\n');
  return `${parts.message}\n\n${t('label.suggestions', 'Suggestions:')}\n${suggestions}`;
}

function buildMessageLines(errors: ReadonlyMap<string, string>, operations: string[]): string[] {
  const errorCount = errors.size;
  const messageLines: string[] = [];

  messageLines.push(errorCount === 1
    ? t('errorAggregator.singleFailure', 'Operation failed: {operation}', {
      operation: localizeOperation(operations[0])
    })
    : t('errorAggregator.multipleFailure', 'Multiple operations failed ({count} errors)', {
      count: String(errorCount)
    }));
  messageLines.push('');
  messageLines.push(t('errorAggregator.whatHappened', 'What happened:'));

  for (const [operation, error] of errors) {
    messageLines.push(`- ${localizeOperation(operation)}: ${localizeError(error)}`);
  }

  return messageLines;
}

function generateSuggestionList(operations: string[], errorMessages: string[]): string[] {
  const suggestions: string[] = [];

  addGitSuggestions(suggestions, operations, errorMessages);
  addVscodeSuggestions(suggestions, operations);
  addNpmSuggestions(suggestions, operations, errorMessages);
  addSystemProxySuggestions(suggestions, operations);
  addNetworkSuggestions(suggestions, errorMessages);
  addPermissionSuggestions(suggestions, errorMessages);

  if (suggestions.length === 0) {
    suggestions.push(t('suggestion.generic.checkDetails', 'Check the error details above for specific issues'));
    suggestions.push(t('suggestion.generic.tryAgain', 'Try the operation again'));
    suggestions.push(t('suggestion.vscode.restartIfPersists', 'Restart VS Code if the problem persists'));
  }

  return [...new Set(suggestions)];
}

function addGitSuggestions(suggestions: string[], operations: string[], errorMessages: string[]): void {
  if (!hasOperation(operations, 'git')) {
    return;
  }

  if (hasGitInstallError(errorMessages)) {
    suggestions.push(t('suggestion.git.installGit', 'Install Git from https://git-scm.com'));
    suggestions.push(t('suggestion.git.ensurePath', 'Ensure Git is added to your system PATH'));
    suggestions.push(t('suggestion.git.restartAfterInstall', 'Restart VS Code after installing Git'));
    return;
  }

  if (hasGitLockError(errorMessages)) {
    suggestions.push(t('suggestion.git.closeOtherWindows', 'Close other VS Code/Cursor windows and Git processes, then try again'));
    suggestions.push(t('suggestion.git.waitAndRetry', 'Wait a few seconds and retry the operation'));
    suggestions.push(t('suggestion.git.removeStaleLock', 'If a stale lock file exists, delete the global Git config lock (e.g., ~/.gitconfig.lock or %USERPROFILE%\\.gitconfig.lock)'));
    return;
  }

  suggestions.push(t('suggestion.git.checkInstallationAndPermissions', 'Check Git installation and permissions'));
  suggestions.push(t('suggestion.git.tryManualCommands', 'Try running Git commands manually in terminal'));
}

function addVscodeSuggestions(suggestions: string[], operations: string[]): void {
  if (hasOperation(operations, 'vscode')) {
    suggestions.push(t('suggestion.vscode.checkSettingsPermissions', 'Check VS Code settings permissions'));
    suggestions.push(t('suggestion.vscode.restart', 'Try restarting VS Code'));
  }
}

function addNpmSuggestions(suggestions: string[], operations: string[], errorMessages: string[]): void {
  if (hasOperation(operations, 'npm')) {
    suggestions.push(...getNpmCategorySuggestions(errorMessages));
  }
}

function addSystemProxySuggestions(suggestions: string[], operations: string[]): void {
  if (operations.some(op => includesLower(op, 'system') || includesLower(op, 'detect'))) {
    suggestions.push(t('suggestion.proxy.configureManualInstead', 'Manually enter proxy URL instead of auto-detection'));
    suggestions.push(t('suggestion.proxy.checkSystemSettings', 'Check system proxy settings in your OS'));
  }
}

function addNetworkSuggestions(suggestions: string[], errorMessages: string[]): void {
  if (errorMessages.some(err => includesAnyLower(err, ['connection', 'timeout', 'network']))) {
    suggestions.push(t('suggestion.verifyUrl', 'Verify proxy URL is correct'));
    suggestions.push(t('suggestion.checkConnectivity', 'Check network connectivity'));
    suggestions.push(t('suggestion.proxy.ensureServerAccessible', 'Ensure proxy server is accessible'));
  }
}

function addPermissionSuggestions(suggestions: string[], errorMessages: string[]): void {
  if (errorMessages.some(err => includesAnyLower(err, ['permission', 'access denied']))) {
    suggestions.push(t('suggestion.permissions.checkFiles', 'Check file and directory permissions'));
    suggestions.push(t('suggestion.vscode.runWithPermissions', 'Try running VS Code with appropriate permissions'));
  }
}

function getNpmCategorySuggestions(errorMessages: string[]): string[] {
  if (hasNpmInstallError(errorMessages)) {
    return [
      t('suggestion.npm.installNode', 'Install Node.js and npm from https://nodejs.org/'),
      t('suggestion.npm.verifyPath', 'Verify npm is in your system PATH'),
      t('suggestion.npm.restartAfterInstall', 'Restart VS Code after installing npm')
    ];
  }

  if (errorMessages.some(err => includesLower(err, 'permission'))) {
    return [
      t('suggestion.npm.checkPermissions', 'Check file permissions for npm config files'),
      t('suggestion.npm.runWithPermissions', 'Try running VS Code with appropriate permissions'),
      t('suggestion.npm.verifyGlobalWrite', 'Verify you have write access to npm\'s global config')
    ];
  }

  if (errorMessages.some(err => includesAnyLower(err, ['timeout', 'timed out']))) {
    return [
      t('suggestion.npm.checkResponding', 'Check if npm is responding correctly'),
      t('suggestion.npm.tryConfigList', 'Try running \'npm config list\' manually to verify npm works'),
      t('suggestion.vscode.restartAndRetry', 'Restart VS Code and try again')
    ];
  }

  if (errorMessages.some(err => includesLower(err, 'config'))) {
    return [
      t('suggestion.npm.verifyConfig', 'Verify npm configuration is not corrupted'),
      t('suggestion.npm.checkConfigList', 'Try running \'npm config list\' to check npm config'),
      t('suggestion.npm.resetConfig', 'Consider resetting npm config with \'npm config edit\'')
    ];
  }

  return [
    t('suggestion.npm.checkInstallationAndConfig', 'Check npm installation and configuration'),
    t('suggestion.npm.tryManualCommands', 'Try running npm commands manually to diagnose the issue')
  ];
}

function hasOperation(operations: string[], fragment: string): boolean {
  return operations.some(op => includesLower(op, fragment));
}

function hasGitInstallError(errorMessages: string[]): boolean {
  return errorMessages.some(err => includesAnyLower(err, ['not found', 'not installed']));
}

function hasGitLockError(errorMessages: string[]): boolean {
  return errorMessages.some(err => includesAnyLower(err, [
    'could not lock config file',
    'git config file is locked',
    'git configuration is already being updated',
    'timed out acquiring git config mutex'
  ]));
}

function hasNpmInstallError(errorMessages: string[]): boolean {
  return errorMessages.some(err => includesAnyLower(err, ['not found', 'not installed', 'enoent']));
}

function localizeOperation(operation: string): string {
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
  return key ? t(key, operation) : operation;
}

function localizeError(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes('git configuration is already being updated') ||
    lower.includes('timed out acquiring git config mutex')) {
    return t(
      'error.gitConfigUpdateInProgress',
      'Git configuration is already being updated by another VS Code/Cursor window. Please wait a few seconds and try again.'
    );
  }

  return error;
}

function t(key: string, fallback: string, params?: Record<string, string>): string {
  try {
    const message = I18nManager.getInstance().t(key, params);
    if (!message.startsWith('[missing:')) {
      return message;
    }
  } catch {
    // Unit tests may use ErrorAggregator without initializing the extension i18n manager.
  }

  return substituteParams(fallback, params);
}

function substituteParams(message: string, params?: Record<string, string>): string {
  if (!params) {
    return message;
  }

  let result = message;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

function includesAnyLower(value: string, fragments: string[]): boolean {
  return fragments.some(fragment => includesLower(value, fragment));
}

function includesLower(value: string, fragment: string): boolean {
  return value.toLowerCase().includes(fragment);
}
