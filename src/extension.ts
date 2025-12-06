import * as vscode from 'vscode';
import { ProxyUrlValidator } from './validation/ProxyUrlValidator';
import { InputSanitizer } from './validation/InputSanitizer';
import { GitConfigManager } from './config/GitConfigManager';
import { VscodeConfigManager } from './config/VscodeConfigManager';
import { NpmConfigManager } from './config/NpmConfigManager';
import { SystemProxyDetector } from './config/SystemProxyDetector';
import { UserNotifier } from './errors/UserNotifier';
import { ErrorAggregator } from './errors/ErrorAggregator';
import { Logger } from './utils/Logger';
import { ProxyMonitor, ProxyDetectionResult } from './monitoring/ProxyMonitor';
import { ProxyChangeLogger } from './monitoring/ProxyChangeLogger';
import { I18nManager } from './i18n/I18nManager';

const validator = new ProxyUrlValidator();
const sanitizer = new InputSanitizer();
const gitConfigManager = new GitConfigManager();
const vscodeConfigManager = new VscodeConfigManager();
const npmConfigManager = new NpmConfigManager();

// Initialize configuration from settings
const config = vscode.workspace.getConfiguration('otakProxy');
const detectionSourcePriority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
const systemProxyDetector = new SystemProxyDetector(detectionSourcePriority);
const userNotifier = new UserNotifier();

// Initialize ProxyMonitor components
const proxyChangeLogger = new ProxyChangeLogger(sanitizer);
let proxyMonitor: ProxyMonitor;

let statusBarItem: vscode.StatusBarItem;
let systemProxyCheckInterval: NodeJS.Timeout | undefined;

enum ProxyMode {
    Off = 'off',
    Manual = 'manual',
    Auto = 'auto'
}

interface ProxyState {
    mode: ProxyMode;
    manualProxyUrl?: string;
    autoProxyUrl?: string;
    lastSystemProxyCheck?: number;
    // Configuration state tracking
    gitConfigured?: boolean;
    vscodeConfigured?: boolean;
    npmConfigured?: boolean;
    systemProxyDetected?: boolean;
    lastError?: string;
}

function validateProxyUrl(url: string): boolean {
    const result = validator.validate(url);
    if (!result.isValid && result.errors.length > 0) {
        Logger.error('Proxy URL validation failed:', result.errors.join(', '));
    }
    return result.isValid;
}

function sanitizeProxyUrl(url: string): string {
    // Use InputSanitizer class for consistent credential masking
    return sanitizer.maskPassword(url);
}

// escapeShellArg function removed - no longer needed with execFile()

async function getProxyState(context: vscode.ExtensionContext): Promise<ProxyState> {
    // If we have an in-memory fallback state, use it
    if (inMemoryProxyState) {
        return inMemoryProxyState;
    }
    
    const state = context.globalState.get<ProxyState>('proxyState');
    if (!state) {
        // Migrate from old settings
        const oldEnabled = context.globalState.get<boolean>('proxyEnabled', false);
        const config = vscode.workspace.getConfiguration('otakProxy');
        const manualUrl = config.get<string>('proxyUrl', '');

        return {
            mode: oldEnabled && manualUrl ? ProxyMode.Manual : ProxyMode.Off,
            manualProxyUrl: manualUrl,
            autoProxyUrl: undefined,
            lastSystemProxyCheck: undefined,
            gitConfigured: undefined,
            vscodeConfigured: undefined,
            systemProxyDetected: undefined,
            lastError: undefined
        };
    }
    return state;
}

// In-memory fallback state for when global state write fails
let inMemoryProxyState: ProxyState | null = null;

async function saveProxyState(context: vscode.ExtensionContext, state: ProxyState): Promise<void> {
    try {
        await context.globalState.update('proxyState', state);
        // Clear in-memory fallback on successful write
        inMemoryProxyState = null;
    } catch (error) {
        // Requirement 4.4: Log error and continue with in-memory state
        Logger.error('Failed to write proxy state to global storage:', error);
        Logger.log('Continuing with in-memory state as fallback');
        inMemoryProxyState = { ...state };
        
        // Optionally notify user about the issue
        const i18n = I18nManager.getInstance();
        vscode.window.showWarningMessage(
            i18n.t('warning.unableToPersist'),
            i18n.t('action.ok')
        );
    }
}

function getActiveProxyUrl(state: ProxyState): string {
    switch (state.mode) {
        case ProxyMode.Auto:
            return state.autoProxyUrl || '';
        case ProxyMode.Manual:
            return state.manualProxyUrl || '';
        default:
            return '';
    }
}

function getNextMode(currentMode: ProxyMode): ProxyMode {
    switch (currentMode) {
        case ProxyMode.Off:
            return ProxyMode.Manual;
        case ProxyMode.Manual:
            return ProxyMode.Auto;
        case ProxyMode.Auto:
            return ProxyMode.Off;
        default:
            return ProxyMode.Off;
    }
}

function initializeStatusBar(context: vscode.ExtensionContext) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'otak-proxy.toggleProxy';
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

async function startSystemProxyMonitoring(context: vscode.ExtensionContext): Promise<void> {
    // Check system proxy immediately using legacy method
    await checkAndUpdateSystemProxy(context);

    // Stop any existing legacy interval
    if (systemProxyCheckInterval) {
        clearInterval(systemProxyCheckInterval);
        systemProxyCheckInterval = undefined;
    }

    // Start ProxyMonitor for polling-based checks
    if (proxyMonitor && !proxyMonitor.getState().isActive) {
        proxyMonitor.start();
        Logger.info('ProxyMonitor started for Auto mode');
    }
}

async function checkAndUpdateSystemProxy(context: vscode.ExtensionContext): Promise<void> {
    const state = await getProxyState(context);

    // Only check if in Auto mode or if it's been more than 5 minutes since last check
    const now = Date.now();
    if (state.mode !== ProxyMode.Auto &&
        state.lastSystemProxyCheck &&
        (now - state.lastSystemProxyCheck) < 300000) {
        return;
    }

    const detectedProxy = await detectSystemProxySettings();
    state.lastSystemProxyCheck = now;
    
    // Track system proxy detection success/failure
    state.systemProxyDetected = !!detectedProxy;

    if (state.mode === ProxyMode.Auto) {
        const previousProxy = state.autoProxyUrl;
        state.autoProxyUrl = detectedProxy || undefined;

        if (previousProxy !== state.autoProxyUrl) {
            // System proxy changed, update everything
            await saveProxyState(context, state);
            await applyProxySettings(state.autoProxyUrl || '', true, context);
            updateStatusBar(state);

            if (state.autoProxyUrl) {
                userNotifier.showSuccess('message.systemProxyChanged', { url: sanitizeProxyUrl(state.autoProxyUrl) });
            } else if (previousProxy) {
                userNotifier.showSuccess('message.systemProxyRemoved');
            }
        }
    } else {
        // Just save the detected proxy for later use
        state.autoProxyUrl = detectedProxy || undefined;
        await saveProxyState(context, state);
    }
}

async function stopSystemProxyMonitoring(): Promise<void> {
    // Stop legacy interval if running
    if (systemProxyCheckInterval) {
        clearInterval(systemProxyCheckInterval);
        systemProxyCheckInterval = undefined;
    }

    // Stop ProxyMonitor
    if (proxyMonitor && proxyMonitor.getState().isActive) {
        proxyMonitor.stop();
        Logger.info('ProxyMonitor stopped');
    }
}

/**
 * Tests proxy connection with comprehensive error reporting
 * Requirement 2.4: Use ErrorAggregator to collect test failures from multiple URLs
 * @returns Object with success status, error aggregator, and test URLs
 */
async function testProxyConnection(proxyUrl: string): Promise<{ success: boolean; errorAggregator: ErrorAggregator; testUrls: string[] }> {
    const errorAggregator = new ErrorAggregator();
    const testUrls = [
        'https://www.github.com',
        'https://www.microsoft.com',
        'https://www.google.com'
    ];

    try {
        const https = require('https');
        const http = require('http');
        const url = require('url');

        const proxyParsed = url.parse(proxyUrl);

        // Test connection through proxy for each URL
        for (const testUrl of testUrls) {
            try {
                const testParsed = url.parse(testUrl);
                const options = {
                    host: proxyParsed.hostname,
                    port: proxyParsed.port || 8080,
                    method: 'CONNECT',
                    path: `${testParsed.hostname}:443`,
                    timeout: 5000
                };

                const result = await new Promise<boolean>((resolve) => {
                    const req = http.request(options);

                    req.on('connect', () => {
                        resolve(true);
                        req.destroy();
                    });

                    req.on('error', (error: Error) => {
                        // Collect error for this test URL
                        errorAggregator.addError(testUrl, error.message || 'Connection failed');
                        resolve(false);
                    });

                    req.on('timeout', () => {
                        // Collect timeout error for this test URL
                        errorAggregator.addError(testUrl, 'Connection timeout (5 seconds)');
                        req.destroy();
                        resolve(false);
                    });

                    req.end();
                });

                if (result) {
                    // At least one test URL worked - success
                    return { success: true, errorAggregator, testUrls };
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                errorAggregator.addError(testUrl, errorMsg);
                continue; // Try next URL
            }
        }

        // All test URLs failed
        return { success: false, errorAggregator, testUrls };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('Proxy test error:', errorMsg);
        errorAggregator.addError('Proxy test', errorMsg);
        return { success: false, errorAggregator, testUrls };
    }
}

async function detectSystemProxySettings(): Promise<string | null> {
    // Requirement 2.3, 3.5, 4.5: Use SystemProxyDetector class with validation and error handling
    try {
        const detectedProxy = await systemProxyDetector.detectSystemProxy();
        
        if (!detectedProxy) {
            // Requirement 2.3: Log failure reason and inform user
            Logger.log('No system proxy detected');
            return null;
        }
        
        // Requirement 3.5: Validate detected proxy before returning
        const validationResult = validator.validate(detectedProxy);
        if (!validationResult.isValid) {
            // Requirement 3.5: Skip invalid proxy and log the issue
            Logger.warn('Detected system proxy has invalid format:', detectedProxy);
            Logger.warn('Validation errors:', validationResult.errors.join(', '));
            
            // Requirement 2.3: Inform user about invalid format
            userNotifier.showWarning(
                `Detected system proxy has invalid format: ${sanitizer.maskPassword(detectedProxy)}`
            );
            
            return null;
        }
        
        // Return validated proxy
        return detectedProxy;
    } catch (error) {
        // Requirement 4.5: Handle detection failures gracefully
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error('System proxy detection failed:', errorMsg);
        
        // Requirement 2.3: Inform user about detection failure
        userNotifier.showWarning('System proxy detection failed. You can configure a proxy manually.');
        
        return null;
    }
}

async function askForInitialSetup(context: vscode.ExtensionContext) {
    const state = await getProxyState(context);
    const i18n = I18nManager.getInstance();

    // First, ask what mode to use
    const modeAnswer = await vscode.window.showInformationMessage(
        i18n.t('prompt.initialSetup'),
        i18n.t('action.autoSystem'),
        i18n.t('action.manualSetup'),
        i18n.t('action.skip')
    );

    if (modeAnswer === i18n.t('action.autoSystem')) {
        // Try to detect system proxy settings
        const detectedProxy = await detectSystemProxySettings();

        if (detectedProxy && validateProxyUrl(detectedProxy)) {
            state.autoProxyUrl = detectedProxy;
            state.mode = ProxyMode.Auto;
            await saveProxyState(context, state);
            await applyProxySettings(detectedProxy, true, context);
            updateStatusBar(state);
            userNotifier.showSuccess('message.usingSystemProxy', { url: sanitizeProxyUrl(detectedProxy) });
        } else {
            const fallback = await vscode.window.showInformationMessage(
                i18n.t('prompt.couldNotDetect'),
                i18n.t('action.yes'),
                i18n.t('action.no')
            );

            if (fallback === i18n.t('action.yes')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
                const updatedState = await getProxyState(context);
                if (updatedState.manualProxyUrl) {
                    updatedState.mode = ProxyMode.Manual;
                    await saveProxyState(context, updatedState);
                    await applyProxySettings(updatedState.manualProxyUrl, true, context);
                    updateStatusBar(updatedState);
                }
            }
        }
    } else if (modeAnswer === i18n.t('action.manualSetup')) {
        const manualProxyUrl = await vscode.window.showInputBox({
            prompt: i18n.t('prompt.proxyUrl'),
            placeHolder: i18n.t('prompt.proxyUrlPlaceholder')
        });

        if (manualProxyUrl) {
            if (!validateProxyUrl(manualProxyUrl)) {
                userNotifier.showError(
                    'error.invalidProxyUrl',
                    [
                        'suggestion.useFormat',
                        'suggestion.includeProtocol',
                        'suggestion.validHostname'
                    ]
                );
                return;
            }
            state.manualProxyUrl = manualProxyUrl;
            state.mode = ProxyMode.Manual;
            await saveProxyState(context, state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', manualProxyUrl, vscode.ConfigurationTarget.Global);

            await applyProxySettings(manualProxyUrl, true, context);
            updateStatusBar(state);
            userNotifier.showSuccess('message.manualProxyConfigured', { url: sanitizeProxyUrl(manualProxyUrl) });
        }
    }

    // Start monitoring if in auto mode
    if (state.mode === ProxyMode.Auto) {
        await startSystemProxyMonitoring(context);
    }
}

/**
 * Initialize ProxyMonitor with configuration from settings
 */
function initializeProxyMonitor(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('otakProxy');
    const pollingInterval = config.get<number>('pollingInterval', 30);
    const maxRetries = config.get<number>('maxRetries', 3);
    const priority = config.get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);

    // Update SystemProxyDetector priority
    systemProxyDetector.updateDetectionPriority(priority);

    // Create ProxyMonitor with configuration
    proxyMonitor = new ProxyMonitor(
        systemProxyDetector,
        proxyChangeLogger,
        {
            pollingInterval: pollingInterval * 1000, // Convert seconds to ms
            debounceDelay: 1000, // 1 second debounce
            maxRetries: maxRetries,
            retryBackoffBase: 1, // 1 second base
            detectionSourcePriority: priority
        }
    );

    // Set up proxyChanged event handler
    proxyMonitor.on('proxyChanged', async (result: ProxyDetectionResult) => {
        const state = await getProxyState(context);
        if (state.mode === ProxyMode.Auto) {
            const previousProxy = state.autoProxyUrl;
            state.autoProxyUrl = result.proxyUrl || undefined;

            if (previousProxy !== state.autoProxyUrl) {
                await saveProxyState(context, state);
                await applyProxySettings(state.autoProxyUrl || '', true, context);
                updateStatusBar(state);

                if (state.autoProxyUrl) {
                    userNotifier.showSuccess(
                        'message.systemProxyChanged',
                        { url: sanitizeProxyUrl(state.autoProxyUrl) }
                    );
                } else if (previousProxy) {
                    userNotifier.showSuccess('message.systemProxyRemoved');
                }
            }
        }
    });

    // Set up allRetriesFailed event handler
    proxyMonitor.on('allRetriesFailed', (data: { error: string; trigger: string }) => {
        Logger.error(`All proxy detection retries failed: ${data.error}`);
        userNotifier.showWarning(
            'System proxy detection failed after multiple retries. Check your system/browser proxy settings.'
        );
    });
}

/**
 * Register all commands for the extension
 * This function is called early in the activation process to ensure
 * commands are available before the status bar displays command links.
 *
 * Requirement 1.1, 5.1: All commands must be registered before status bar display
 *
 * @param context - The extension context
 */
export function registerCommands(context: vscode.ExtensionContext): void {
    // Toggle proxy command - cycles through Off -> Manual -> Auto -> Off
    // Requirement 1.4, 4.4: Error handling for command execution
    const toggleDisposable = vscode.commands.registerCommand('otak-proxy.toggleProxy', async () => {
        try {
            const currentState = await getProxyState(context);
            const nextMode = getNextMode(currentState.mode);

        // Check if we can switch to the next mode
        const i18n = I18nManager.getInstance();
        
        if (nextMode === ProxyMode.Manual && !currentState.manualProxyUrl) {
            // No manual proxy configured, prompt for setup
            const answer = await vscode.window.showInformationMessage(
                i18n.t('prompt.noManualProxy'),
                i18n.t('action.yes'),
                i18n.t('action.skipToAuto')
            );

            if (answer === i18n.t('action.yes')) {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
                return;
            } else if (answer === i18n.t('action.skipToAuto')) {
                currentState.mode = ProxyMode.Auto;
            } else {
                return; // User cancelled
            }
        } else if (nextMode === ProxyMode.Auto && !currentState.autoProxyUrl) {
            // No system proxy detected, check now
            await checkAndUpdateSystemProxy(context);
            const updatedState = await getProxyState(context);

            if (!updatedState.autoProxyUrl) {
                // Show notification and automatically switch to Off mode
                userNotifier.showWarning('warning.noSystemProxyDetected');
                currentState.mode = ProxyMode.Off;
            } else {
                currentState.mode = nextMode;
            }
        } else {
            currentState.mode = nextMode;
        }

        // Apply the new mode
        await saveProxyState(context, currentState);
        const newActiveUrl = getActiveProxyUrl(currentState);
        await applyProxySettings(newActiveUrl, currentState.mode !== ProxyMode.Off, context);
        updateStatusBar(currentState);

        // Start or stop monitoring based on mode
        if (currentState.mode === ProxyMode.Auto) {
            await startSystemProxyMonitoring(context);
        }
        } catch (error) {
            Logger.error('Toggle proxy command failed:', error);
            userNotifier.showError(
                'error.toggleFailed',
                ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
            );
        }
    });
    context.subscriptions.push(toggleDisposable);

    // Manual proxy configuration command
    // Requirement 1.4, 4.4: Error handling for command execution
    const configureUrlDisposable = vscode.commands.registerCommand('otak-proxy.configureUrl', async () => {
        try {
            const state = await getProxyState(context);
            const proxyUrl = await vscode.window.showInputBox({
            prompt: 'Enter proxy URL (e.g., http://proxy.example.com:8080)',
            placeHolder: 'http://proxy.example.com:8080',
            value: state.manualProxyUrl || ''
        });

        if (proxyUrl !== undefined) {
            if (proxyUrl && !validateProxyUrl(proxyUrl)) {
                userNotifier.showError(
                    'Invalid proxy URL format',
                    [
                        'Use format: http://proxy.example.com:8080',
                        'Include protocol (http:// or https://)',
                        'Ensure hostname contains only alphanumeric characters, dots, and hyphens'
                    ]
                );
                return;
            }

            // Save manual proxy URL
            state.manualProxyUrl = proxyUrl;
            await saveProxyState(context, state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', proxyUrl, vscode.ConfigurationTarget.Global);

            // If currently in manual mode, apply the new settings
            if (state.mode === ProxyMode.Manual) {
                if (proxyUrl) {
                    await applyProxySettings(proxyUrl, true, context);
                } else {
                    // Manual proxy was removed, switch to Off
                    state.mode = ProxyMode.Off;
                    await saveProxyState(context, state);
                    await applyProxySettings('', false, context);
                }
                updateStatusBar(state);
            }
        }
        } catch (error) {
            Logger.error('Configure URL command failed:', error);
            userNotifier.showError(
                'Failed to configure proxy URL',
                ['Check the output log for details', 'Try reloading the window']
            );
        }
    });
    context.subscriptions.push(configureUrlDisposable);

    // Proxy test command
    // Requirement 2.4: Enhanced with comprehensive error reporting
    // Requirement 3.1, 3.2: Action buttons when no proxy configured
    // Requirement 1.4, 4.4: Error handling for command execution
    const testProxyDisposable = vscode.commands.registerCommand('otak-proxy.testProxy', async () => {
        try {
            const state = await getProxyState(context);
            const activeUrl = getActiveProxyUrl(state);
            const i18n = I18nManager.getInstance();

            if (!activeUrl) {
                // Requirement 3.1, 3.2: Show error with action buttons
                const action = await vscode.window.showErrorMessage(
                    i18n.t('message.noProxyConfigured', { mode: state.mode.toUpperCase() }),
                    i18n.t('action.configureManual'),
                    i18n.t('action.importSystem'),
                    i18n.t('action.cancel')
                );

                if (action === i18n.t('action.configureManual')) {
                    await vscode.commands.executeCommand('otak-proxy.configureUrl');
                } else if (action === i18n.t('action.importSystem')) {
                    await vscode.commands.executeCommand('otak-proxy.importProxy');
                }
                return;
            }

            // Requirement 1.5, 6.2: Use sanitized URL for display
            const sanitizedUrl = sanitizer.maskPassword(activeUrl);

            const testResult = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('message.testingProxy', { mode: state.mode, url: sanitizedUrl }),
                cancellable: false
            }, async () => {
                return await testProxyConnection(activeUrl);
            });

            if (testResult.success) {
                userNotifier.showSuccess('message.proxyWorks', { mode: state.mode.toUpperCase(), url: sanitizedUrl });
            } else {
                // Requirement 2.4: Display attempted URLs in error messages
                const attemptedUrlsList = testResult.testUrls.map(url => `  • ${url}`).join('\n');

                // Requirement 2.4: Provide troubleshooting suggestions via UserNotifier
                const suggestions = [
                    i18n.t('suggestion.verifyUrl'),
                    i18n.t('suggestion.checkServer'),
                    i18n.t('suggestion.checkNetwork'),
                    i18n.t('suggestion.checkFirewall'),
                    state.mode === ProxyMode.Manual
                        ? i18n.t('suggestion.reconfigureManual')
                        : i18n.t('suggestion.checkSystemSettings'),
                    i18n.t('suggestion.testDifferentApp')
                ];

                // Build comprehensive error message with attempted URLs
                let errorMessage = i18n.t('error.proxyTestFailed', { url: sanitizedUrl }) + `\n\n${i18n.t('error.attemptedUrls')}\n${attemptedUrlsList}`;

                // Add specific error details if available
                if (testResult.errorAggregator.hasErrors()) {
                    const formattedErrors = testResult.errorAggregator.formatErrors();
                    errorMessage += `\n\n${formattedErrors}`;
                }

                // Use UserNotifier for consistent error display
                userNotifier.showError(errorMessage, suggestions);
            }
        } catch (error) {
            Logger.error('Test proxy command failed:', error);
            userNotifier.showError(
                'error.testProxyFailed',
                ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
            );
        }
    });
    context.subscriptions.push(testProxyDisposable);

    // Import system proxy command
    // Requirement 1.4, 4.4: Error handling for command execution
    const importProxyDisposable = vscode.commands.registerCommand('otak-proxy.importProxy', async () => {
        try {
            const i18n = I18nManager.getInstance();
            const detectedProxy = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.t('message.detectingSystemProxy'),
                cancellable: false
            }, async () => {
                return await detectSystemProxySettings();
            });

            const state = await getProxyState(context);

            if (detectedProxy) {
                // Requirement 2.3: Display sanitized proxy URL to user
                const sanitizedProxy = sanitizer.maskPassword(detectedProxy);
                const action = await vscode.window.showInformationMessage(
                    i18n.t('prompt.foundSystemProxy', { url: sanitizedProxy }),
                    i18n.t('action.useAutoMode'),
                    i18n.t('action.testFirst'),
                    i18n.t('action.saveAsManual'),
                    i18n.t('action.cancel')
                );

                if (action === i18n.t('action.testFirst')) {
                    const testResult = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: i18n.t('message.testingProxyGeneric'),
                        cancellable: false
                    }, async () => {
                        return await testProxyConnection(detectedProxy);
                    });

                    if (testResult.success) {
                        const useAction = await vscode.window.showInformationMessage(
                            i18n.t('prompt.proxyWorks'),
                            i18n.t('action.useAutoMode'),
                            i18n.t('action.saveAsManual'),
                            i18n.t('action.cancel')
                        );

                        if (useAction === i18n.t('action.useAutoMode')) {
                            if (validateProxyUrl(detectedProxy)) {
                                state.autoProxyUrl = detectedProxy;
                                state.mode = ProxyMode.Auto;
                                await saveProxyState(context, state);
                                await applyProxySettings(detectedProxy, true, context);
                                updateStatusBar(state);
                                await startSystemProxyMonitoring(context);
                                userNotifier.showSuccess('message.switchedToAutoMode', { url: sanitizeProxyUrl(detectedProxy) });
                            } else {
                                userNotifier.showError(
                                    'error.invalidProxyUrlDetected',
                                    [
                                        'suggestion.invalidFormatDetected',
                                        'suggestion.checkSystemSettings',
                                        'suggestion.configureManualInstead'
                                    ]
                                );
                            }
                        } else if (useAction === i18n.t('action.saveAsManual')) {
                            if (validateProxyUrl(detectedProxy)) {
                                state.manualProxyUrl = detectedProxy;
                                state.mode = ProxyMode.Manual;
                                await saveProxyState(context, state);
                                await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                                await applyProxySettings(detectedProxy, true, context);
                                updateStatusBar(state);
                                userNotifier.showSuccess('message.savedAsManualProxy', { url: sanitizeProxyUrl(detectedProxy) });
                            } else {
                                userNotifier.showError(
                                    'error.invalidProxyUrlDetected',
                                    [
                                        'suggestion.invalidFormatDetected',
                                        'suggestion.checkSystemSettings',
                                        'suggestion.configureManualInstead'
                                    ]
                                );
                            }
                        }
                    } else {
                        userNotifier.showError(
                            'error.proxyDoesNotWork',
                            [
                                'suggestion.verifyServerRunning',
                                'suggestion.checkConnectivity',
                                'suggestion.tryDifferentConfig'
                            ]
                        );
                    }
                } else if (action === i18n.t('action.useAutoMode')) {
                    if (validateProxyUrl(detectedProxy)) {
                        state.autoProxyUrl = detectedProxy;
                        state.mode = ProxyMode.Auto;
                        await saveProxyState(context, state);
                        await applyProxySettings(detectedProxy, true, context);
                        updateStatusBar(state);
                        await startSystemProxyMonitoring(context);
                        userNotifier.showSuccess('message.switchedToAutoMode', { url: sanitizeProxyUrl(detectedProxy) });
                    } else {
                        userNotifier.showError(
                            'error.invalidProxyUrlDetected',
                            [
                                'suggestion.invalidFormatDetected',
                                'suggestion.checkSystemSettings',
                                'suggestion.configureManualInstead'
                            ]
                        );
                    }
                } else if (action === i18n.t('action.saveAsManual')) {
                    if (validateProxyUrl(detectedProxy)) {
                        state.manualProxyUrl = detectedProxy;
                        await saveProxyState(context, state);
                        await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                        updateStatusBar(state);
                        userNotifier.showSuccess('message.savedAsManualProxy', { url: sanitizeProxyUrl(detectedProxy) });
                    } else {
                        userNotifier.showError(
                            'error.invalidProxyUrlDetected',
                            [
                                'suggestion.invalidFormatDetected',
                                'suggestion.checkSystemSettings',
                                'suggestion.configureManualInstead'
                            ]
                        );
                    }
                }
            } else {
                userNotifier.showWarning('warning.noSystemProxyCheck');
            }
        } catch (error) {
            Logger.error('Import proxy command failed:', error);
            userNotifier.showError(
                'error.importProxyFailed',
                ['suggestion.checkOutputLog', 'suggestion.reloadWindow']
            );
        }
    });
    context.subscriptions.push(importProxyDisposable);

    // Configuration change listener
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async e => {
        if (e.affectsConfiguration('otakProxy.proxyUrl')) {
            const state = await getProxyState(context);
            const newUrl = vscode.workspace.getConfiguration('otakProxy').get<string>('proxyUrl', '');

            // Update manual proxy URL
            if (newUrl !== state.manualProxyUrl) {
                state.manualProxyUrl = newUrl;
                await saveProxyState(context, state);

                // If currently in manual mode, apply the new settings
                if (state.mode === ProxyMode.Manual) {
                    await applyProxySettings(newUrl, !!newUrl, context);
                    updateStatusBar(state);
                }
            }
        }

        // Handle polling interval change
        if (e.affectsConfiguration('otakProxy.pollingInterval')) {
            const newInterval = vscode.workspace
                .getConfiguration('otakProxy')
                .get<number>('pollingInterval', 30);
            proxyMonitor.updateConfig({
                pollingInterval: newInterval * 1000 // Convert seconds to ms
            });
            Logger.info(`Polling interval updated to ${newInterval} seconds`);
        }

        // Handle detection source priority change
        if (e.affectsConfiguration('otakProxy.detectionSourcePriority')) {
            const newPriority = vscode.workspace
                .getConfiguration('otakProxy')
                .get<string[]>('detectionSourcePriority', ['environment', 'vscode', 'platform']);
            systemProxyDetector.updateDetectionPriority(newPriority);
            proxyMonitor.updateConfig({
                detectionSourcePriority: newPriority
            });
            Logger.info(`Detection source priority updated to: ${newPriority.join(', ')}`);
        }

        // Handle max retries change
        if (e.affectsConfiguration('otakProxy.maxRetries')) {
            const newMaxRetries = vscode.workspace
                .getConfiguration('otakProxy')
                .get<number>('maxRetries', 3);
            proxyMonitor.updateConfig({
                maxRetries: newMaxRetries
            });
            Logger.info(`Max retries updated to ${newMaxRetries}`);
        }
    });
    context.subscriptions.push(configChangeDisposable);

    // Listen for window focus to check system proxy changes (using ProxyMonitor)
    const windowFocusDisposable = vscode.window.onDidChangeWindowState(async (windowState) => {
        if (windowState.focused) {
            const state = await getProxyState(context);
            if (state.mode === ProxyMode.Auto) {
                // Use ProxyMonitor for focus-based check
                proxyMonitor.triggerCheck('focus');
            }
        }
    });
    context.subscriptions.push(windowFocusDisposable);
}

/**
 * Perform initial setup for the extension
 * This function handles the initial setup dialog and applies settings.
 *
 * Requirement 1.4, 5.3: Handle initialization gracefully
 *
 * @param context - The extension context
 */
export async function performInitialSetup(context: vscode.ExtensionContext): Promise<void> {
    try {
        const hasSetup = context.globalState.get('hasInitialSetup', false);
        if (!hasSetup) {
            await askForInitialSetup(context);
            await context.globalState.update('hasInitialSetup', true);
        }
    } catch (error) {
        Logger.error('Initial setup failed:', error);
        // Continue with default state - don't throw
    }
}

export async function activate(context: vscode.ExtensionContext) {
    Logger.log('Extension "otak-proxy" is now active.');

    // Phase 0: Initialize I18n
    const i18n = I18nManager.getInstance();
    i18n.initialize();
    Logger.log(`I18n initialized with locale: ${i18n.getCurrentLocale()}`);

    // Phase 1: Core initialization
    statusBarItem = initializeStatusBar(context);
    initializeProxyMonitor(context);

    // Phase 2: State initialization
    let state = await getProxyState(context);

    // Migrate manual URL from config if needed
    const config = vscode.workspace.getConfiguration('otakProxy');
    const configProxyUrl = config.get<string>('proxyUrl', '');
    if (configProxyUrl && !state.manualProxyUrl) {
        state.manualProxyUrl = configProxyUrl;
        await saveProxyState(context, state);
    }

    // Phase 3: Command registration (BEFORE status bar display)
    // Requirement 1.1, 5.1: All commands must be registered before status bar displays command links
    registerCommands(context);

    // Phase 4: UI initialization
    updateStatusBar(state);

    // Phase 5: Initial setup (after commands are registered)
    await performInitialSetup(context);
    state = await getProxyState(context); // Reload state after setup

    // Phase 6: Apply current proxy settings
    const activeUrl = getActiveProxyUrl(state);
    if (state.mode !== ProxyMode.Off && activeUrl) {
        await applyProxySettings(activeUrl, true, context);
    }

    // Phase 7: Start monitoring
    await startSystemProxyMonitoring(context);
}

/**
 * Disables proxy settings across all configuration targets
 * Requirement 2.5: Use ErrorAggregator and UserNotifier for comprehensive error handling
 */
async function disableProxySettings(context?: vscode.ExtensionContext): Promise<boolean> {
    const errorAggregator = new ErrorAggregator();
    
    let gitSuccess = false;
    let vscodeSuccess = false;
    let npmSuccess = false;

    // Use GitConfigManager.unsetProxy()
    try {
        const result = await gitConfigManager.unsetProxy();
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
        const result = await vscodeConfigManager.unsetProxy();
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
        const result = await npmConfigManager.unsetProxy();
        if (!result.success) {
            errorAggregator.addError('npm configuration', result.error || 'Failed to unset npm proxy');
        } else {
            npmSuccess = true;
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errorAggregator.addError('npm configuration', errorMsg);
    }

    // Track configuration state if context is provided
    if (context) {
        try {
            const state = await getProxyState(context);
            state.gitConfigured = false;
            state.vscodeConfigured = false;
            state.npmConfigured = false;
            state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
            await saveProxyState(context, state);
        } catch (error) {
            Logger.error('Failed to update configuration state tracking:', error);
        }
    }

    const success = gitSuccess && vscodeSuccess && npmSuccess;
    
    // Use ErrorAggregator for any failures and UserNotifier for feedback
    if (errorAggregator.hasErrors()) {
        const formattedErrors = errorAggregator.formatErrors();
        const lines = formattedErrors.split('\n');
        const suggestionStartIndex = lines.findIndex(line => line.includes('Suggestions:'));
        const suggestions = suggestionStartIndex >= 0 
            ? lines.slice(suggestionStartIndex + 1).filter(line => line.trim().startsWith('-')).map(line => line.trim().substring(2))
            : [];
        
        const errorMessage = lines.slice(0, suggestionStartIndex >= 0 ? suggestionStartIndex : lines.length).join('\n');
        userNotifier.showError(errorMessage, suggestions);
    } else {
        // Update status bar to show proxy disabled
        userNotifier.showSuccess('message.proxyDisabled');
    }

    return success;
}

async function applyProxySettings(proxyUrl: string, enabled: boolean, context?: vscode.ExtensionContext): Promise<boolean> {
    const errorAggregator = new ErrorAggregator();
    
    // Edge Case 1: Handle empty URL as disable proxy (Requirement 4.1)
    if (!proxyUrl || proxyUrl.trim() === '') {
        enabled = false;
    }
    
    // If disabling, use the dedicated disable function
    if (!enabled) {
        return await disableProxySettings(context);
    }
    
    // Requirement 1.1, 1.3, 1.4, 3.1: Validate proxy URL before any configuration
    if (proxyUrl) {
        const validationResult = validator.validate(proxyUrl);
        if (!validationResult.isValid) {
            // Display validation errors with specific details
            const errorMessage = 'Invalid proxy URL format';
            const suggestions = validationResult.errors.map(err => err);
            suggestions.push('Use format: http://proxy.example.com:8080');
            suggestions.push('Include protocol (http:// or https://)');
            suggestions.push('Ensure hostname contains only alphanumeric characters, dots, and hyphens');
            
            userNotifier.showError(errorMessage, suggestions);
            return false;
        }
    }
    
    let gitSuccess = false;
    let vscodeSuccess = false;
    let npmSuccess = false;

    // Requirement 2.2: Try VSCode configuration, continue on failure
    try {
        await updateVSCodeProxy(enabled, proxyUrl);
        vscodeSuccess = true;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errorAggregator.addError('VSCode configuration', errorMsg);
    }

    // Try Git configuration
    try {
        await updateGitProxy(enabled, proxyUrl);
        gitSuccess = true;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errorAggregator.addError('Git configuration', errorMsg);
    }

    // Try npm configuration
    try {
        await updateNpmProxy(enabled, proxyUrl);
        npmSuccess = true;
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errorAggregator.addError('npm configuration', errorMsg);
    }

    // Track configuration state if context is provided
    if (context) {
        try {
            const state = await getProxyState(context);
            state.gitConfigured = gitSuccess;
            state.vscodeConfigured = vscodeSuccess;
            state.npmConfigured = npmSuccess;
            state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
            await saveProxyState(context, state);
        } catch (error) {
            // Requirement 4.4: If we can't save state, log but don't fail the operation
            Logger.error('Failed to update configuration state tracking:', error);
        }
    }

    const success = gitSuccess && vscodeSuccess && npmSuccess;
    
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
        userNotifier.showError(errorMessage, suggestions);
    } else if (proxyUrl) {
        // Requirement 1.5, 6.2: Update status bar with sanitized proxy URL
        const sanitizedUrl = sanitizer.maskPassword(proxyUrl);
        userNotifier.showSuccess('message.proxyConfigured', { url: sanitizedUrl });
    }

    return success;
}

async function updateVSCodeProxy(enabled: boolean, proxyUrl: string) {
    try {
        let result;
        
        if (enabled) {
            result = await vscodeConfigManager.setProxy(proxyUrl);
        } else {
            result = await vscodeConfigManager.unsetProxy();
        }

        if (!result.success) {
            // Log the error with details
            Logger.error('VSCode proxy configuration failed:', result.error, result.errorType);
            
            // Throw with specific error message
            throw new Error(result.error || 'Failed to update VSCode proxy settings');
        }

        return true;
    } catch (error) {
        Logger.error('VSCode proxy setting error:', error);
        throw error;
    }
}

async function updateGitProxy(enabled: boolean, proxyUrl: string) {
    try {
        let result;
        
        if (enabled) {
            result = await gitConfigManager.setProxy(proxyUrl);
        } else {
            result = await gitConfigManager.unsetProxy();
        }

        if (!result.success) {
            // Log the error with details
            Logger.error('Git proxy configuration failed:', result.error, result.errorType);
            
            // Throw with specific error message
            throw new Error(result.error || 'Failed to update Git proxy settings');
        }

        return true;
    } catch (error) {
        Logger.error('Git proxy setting error:', error);
        throw error;
    }
}

async function updateNpmProxy(enabled: boolean, proxyUrl: string) {
    try {
        let result;
        
        if (enabled) {
            result = await npmConfigManager.setProxy(proxyUrl);
        } else {
            result = await npmConfigManager.unsetProxy();
        }

        if (!result.success) {
            // Log the error with details
            Logger.error('npm proxy configuration failed:', result.error, result.errorType);
            
            // Throw with specific error message
            throw new Error(result.error || 'Failed to update npm proxy settings');
        }

        return true;
    } catch (error) {
        Logger.error('npm proxy setting error:', error);
        throw error;
    }
}


function updateStatusBar(state: ProxyState) {
    if (!statusBarItem) {
        Logger.error('Status bar item not initialized');
        return;
    }

    const i18n = I18nManager.getInstance();
    const activeUrl = getActiveProxyUrl(state);
    let text = '';
    let statusText = '';

    // Get monitoring state and last check info from ProxyMonitor
    const monitorState = proxyMonitor ? proxyMonitor.getState() : null;
    const lastCheck = proxyChangeLogger ? proxyChangeLogger.getLastCheck() : null;

    switch (state.mode) {
        case ProxyMode.Auto:
            if (activeUrl) {
                text = `$(sync~spin) ${i18n.t('statusbar.autoWithUrl', { url: activeUrl })}`;
                statusText = i18n.t('statusbar.tooltip.autoModeUsing', { url: activeUrl });
            } else {
                text = `$(sync~spin) ${i18n.t('statusbar.autoNoProxy')}`;
                statusText = i18n.t('statusbar.tooltip.autoModeNoProxy');
            }
            break;
        case ProxyMode.Manual:
            if (activeUrl) {
                text = `$(plug) ${i18n.t('statusbar.manualWithUrl', { url: activeUrl })}`;
                statusText = i18n.t('statusbar.tooltip.manualModeUsing', { url: activeUrl });
            } else {
                text = `$(plug) ${i18n.t('statusbar.manualNotConfigured')}`;
                statusText = i18n.t('statusbar.tooltip.manualModeNotConfigured');
            }
            break;
        case ProxyMode.Off:
        default:
            text = `$(circle-slash) ${i18n.t('statusbar.proxyOff')}`;
            statusText = i18n.t('statusbar.tooltip.proxyDisabled');
            break;
    }

    statusBarItem.text = text;

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.title')}**\n\n`);
    tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.currentMode')}:** ${state.mode.toUpperCase()}\n\n`);
    tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.status')}:** ${statusText}\n\n`);

    // Add Auto mode specific information
    if (state.mode === ProxyMode.Auto && lastCheck) {
        const lastCheckTime = new Date(lastCheck.timestamp).toLocaleTimeString();
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.lastCheck')}:** ${lastCheckTime}\n\n`);

        if (lastCheck.source) {
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.detectionSource')}:** ${lastCheck.source}\n\n`);
        }

        if (!lastCheck.success && lastCheck.error) {
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.lastError')}:** $(warning) ${lastCheck.error}\n\n`);
        }
    }

    // Add monitoring state information for Auto mode
    if (state.mode === ProxyMode.Auto && monitorState) {
        if (monitorState.consecutiveFailures > 0) {
            tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.consecutiveFailures')}:** $(warning) ${monitorState.consecutiveFailures}\n\n`);
        }
    }

    if (state.manualProxyUrl) {
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.manualProxy')}:** ${sanitizer.maskPassword(state.manualProxyUrl)}\n\n`);
    }
    if (state.autoProxyUrl) {
        tooltip.appendMarkdown(`**${i18n.t('statusbar.tooltip.systemProxy')}:** ${sanitizer.maskPassword(state.autoProxyUrl)}\n\n`);
    }

    tooltip.appendMarkdown(`---\n\n`);

    // Requirement 5.4: Define command links with validation
    const commandLinks = [
        { icon: '$(sync)', label: i18n.t('statusbar.link.toggleMode'), command: 'otak-proxy.toggleProxy' },
        { icon: '$(gear)', label: i18n.t('statusbar.link.configureManual'), command: 'otak-proxy.configureUrl' },
        { icon: '$(cloud-download)', label: i18n.t('statusbar.link.importSystem'), command: 'otak-proxy.importProxy' },
        { icon: '$(debug-start)', label: i18n.t('statusbar.link.testProxy'), command: 'otak-proxy.testProxy' }
    ];

    // Requirement 5.4: Validate all command links reference registered commands
    const registeredCommands = [
        'otak-proxy.toggleProxy',
        'otak-proxy.configureUrl',
        'otak-proxy.testProxy',
        'otak-proxy.importProxy'
    ];

    for (const link of commandLinks) {
        if (!registeredCommands.includes(link.command)) {
            Logger.warn(`Command link references unregistered command: ${link.command}`);
        }
    }

    // Build command links markdown
    const linkMarkdown = commandLinks
        .map(link => `${link.icon} [${link.label}](command:${link.command})`)
        .join(' &nbsp;&nbsp; ');
    tooltip.appendMarkdown(linkMarkdown);

    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}

export async function deactivate() {
    // Stop ProxyMonitor
    if (proxyMonitor) {
        proxyMonitor.stop();
    }
    // Also stop legacy monitoring if running
    await stopSystemProxyMonitoring();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
