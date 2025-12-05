import * as vscode from 'vscode';
import { ProxyUrlValidator } from './validation/ProxyUrlValidator';
import { InputSanitizer } from './validation/InputSanitizer';
import { GitConfigManager } from './config/GitConfigManager';
import { VscodeConfigManager } from './config/VscodeConfigManager';
import { SystemProxyDetector } from './config/SystemProxyDetector';
import { UserNotifier } from './errors/UserNotifier';
import { ErrorAggregator } from './errors/ErrorAggregator';
import { Logger } from './utils/Logger';

const validator = new ProxyUrlValidator();
const sanitizer = new InputSanitizer();
const gitConfigManager = new GitConfigManager();
const vscodeConfigManager = new VscodeConfigManager();
const systemProxyDetector = new SystemProxyDetector();
const userNotifier = new UserNotifier();

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
        vscode.window.showWarningMessage(
            'Unable to persist proxy settings. Settings will be lost when VSCode restarts.',
            'OK'
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
    // Check system proxy immediately
    await checkAndUpdateSystemProxy(context);

    // Stop any existing interval
    if (systemProxyCheckInterval) {
        clearInterval(systemProxyCheckInterval);
    }

    // Check every minute - essential for detecting proxy changes
    systemProxyCheckInterval = setInterval(async () => {
        const state = await getProxyState(context);
        if (state.mode === ProxyMode.Auto) {
            await checkAndUpdateSystemProxy(context);
        }
    }, 60000);  // 1 minute interval
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
                userNotifier.showSuccess(`System proxy changed: ${sanitizeProxyUrl(state.autoProxyUrl)}`);
            } else if (previousProxy) {
                userNotifier.showSuccess('System proxy removed');
            }
        }
    } else {
        // Just save the detected proxy for later use
        state.autoProxyUrl = detectedProxy || undefined;
        await saveProxyState(context, state);
    }
}

async function stopSystemProxyMonitoring(): Promise<void> {
    if (systemProxyCheckInterval) {
        clearInterval(systemProxyCheckInterval);
        systemProxyCheckInterval = undefined;
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

    // First, ask what mode to use
    const modeAnswer = await vscode.window.showInformationMessage(
        'How would you like to configure proxy settings?',
        'Auto (System)',
        'Manual Setup',
        'Skip'
    );

    if (modeAnswer === 'Auto (System)') {
        // Try to detect system proxy settings
        const detectedProxy = await detectSystemProxySettings();

        if (detectedProxy && validateProxyUrl(detectedProxy)) {
            state.autoProxyUrl = detectedProxy;
            state.mode = ProxyMode.Auto;
            await saveProxyState(context, state);
            await applyProxySettings(detectedProxy, true, context);
            updateStatusBar(state);
            userNotifier.showSuccess(`Using system proxy: ${sanitizeProxyUrl(detectedProxy)}`);
        } else {
            const fallback = await vscode.window.showInformationMessage(
                "Couldn't detect system proxy. Set up manually?",
                'Yes',
                'No'
            );

            if (fallback === 'Yes') {
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
    } else if (modeAnswer === 'Manual Setup') {
        const manualProxyUrl = await vscode.window.showInputBox({
            prompt: 'Enter proxy URL (e.g., http://proxy.example.com:8080)',
            placeHolder: 'http://proxy.example.com:8080'
        });

        if (manualProxyUrl) {
            if (!validateProxyUrl(manualProxyUrl)) {
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
            state.manualProxyUrl = manualProxyUrl;
            state.mode = ProxyMode.Manual;
            await saveProxyState(context, state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', manualProxyUrl, vscode.ConfigurationTarget.Global);

            await applyProxySettings(manualProxyUrl, true, context);
            updateStatusBar(state);
            userNotifier.showSuccess(`Manual proxy configured: ${sanitizeProxyUrl(manualProxyUrl)}`);
        }
    }

    // Start monitoring if in auto mode
    if (state.mode === ProxyMode.Auto) {
        await startSystemProxyMonitoring(context);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    Logger.log('Extension "otak-proxy" is now active.');

    // Initialize status bar immediately
    statusBarItem = initializeStatusBar(context);

    // Get or initialize proxy state
    let state = await getProxyState(context);

    // Migrate manual URL from config if needed
    const config = vscode.workspace.getConfiguration('otakProxy');
    const configProxyUrl = config.get<string>('proxyUrl', '');
    if (configProxyUrl && !state.manualProxyUrl) {
        state.manualProxyUrl = configProxyUrl;
        await saveProxyState(context, state);
    }

    // Show initial status
    updateStatusBar(state);

    // Check for initial setup
    const hasSetup = context.globalState.get('hasInitialSetup', false);
    if (!hasSetup) {
        await askForInitialSetup(context);
        state = await getProxyState(context); // Reload state after setup
        await context.globalState.update('hasInitialSetup', true);
    }

    // Apply current proxy settings
    const activeUrl = getActiveProxyUrl(state);
    if (state.mode !== ProxyMode.Off && activeUrl) {
        await applyProxySettings(activeUrl, true, context);
    }

    // Start monitoring system proxy if in auto mode
    await startSystemProxyMonitoring(context);

    // Register commands
    // Toggle proxy command - cycles through Off -> Manual -> Auto -> Off
    let disposable = vscode.commands.registerCommand('otak-proxy.toggleProxy', async () => {
        const currentState = await getProxyState(context);
        const nextMode = getNextMode(currentState.mode);

        // Check if we can switch to the next mode
        if (nextMode === ProxyMode.Manual && !currentState.manualProxyUrl) {
            // No manual proxy configured, prompt for setup
            const answer = await vscode.window.showInformationMessage(
                'No manual proxy configured. Set one up now?',
                'Yes',
                'Skip to Auto'
            );

            if (answer === 'Yes') {
                await vscode.commands.executeCommand('otak-proxy.configureUrl');
                return;
            } else if (answer === 'Skip to Auto') {
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
                userNotifier.showWarning('No system proxy detected. Switching to Off mode.');
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
    });

    context.subscriptions.push(disposable);

    // Manual proxy configuration command
    context.subscriptions.push(
        vscode.commands.registerCommand('otak-proxy.configureUrl', async () => {
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
        })
    );

    // Proxy test command
    // Requirement 2.4: Enhanced with comprehensive error reporting
    context.subscriptions.push(
        vscode.commands.registerCommand('otak-proxy.testProxy', async () => {
            const state = await getProxyState(context);
            const activeUrl = getActiveProxyUrl(state);

            if (!activeUrl) {
                userNotifier.showError(
                    `No proxy configured. Current mode: ${state.mode.toUpperCase()}`,
                    [
                        'Configure a manual proxy using the Configure Manual command',
                        'Switch to Auto mode to detect system proxy',
                        'Import system proxy settings'
                    ]
                );
                return;
            }

            // Requirement 1.5, 6.2: Use sanitized URL for display
            const sanitizedUrl = sanitizer.maskPassword(activeUrl);

            const testResult = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Testing ${state.mode} proxy: ${sanitizedUrl}...`,
                cancellable: false
            }, async () => {
                return await testProxyConnection(activeUrl);
            });

            if (testResult.success) {
                userNotifier.showSuccess(`${state.mode.toUpperCase()} proxy works: ${sanitizedUrl}`);
            } else {
                // Requirement 2.4: Display attempted URLs in error messages
                const attemptedUrlsList = testResult.testUrls.map(url => `  • ${url}`).join('\n');
                
                // Requirement 2.4: Provide troubleshooting suggestions via UserNotifier
                const suggestions = [
                    'Verify the proxy URL is correct',
                    'Check if the proxy server is running and accessible',
                    'Ensure your network allows proxy connections',
                    'Verify firewall settings are not blocking the proxy',
                    state.mode === ProxyMode.Manual 
                        ? 'Try reconfiguring the proxy URL' 
                        : 'Check your system/browser proxy settings',
                    'Test the proxy with a different application to verify it works'
                ];

                // Build comprehensive error message with attempted URLs
                let errorMessage = `Proxy connection test failed for: ${sanitizedUrl}\n\nAttempted test URLs:\n${attemptedUrlsList}`;
                
                // Add specific error details if available
                if (testResult.errorAggregator.hasErrors()) {
                    const formattedErrors = testResult.errorAggregator.formatErrors();
                    errorMessage += `\n\n${formattedErrors}`;
                }

                // Use UserNotifier for consistent error display
                userNotifier.showError(errorMessage, suggestions);
            }
        })
    );

    // Import system proxy command
    context.subscriptions.push(
        vscode.commands.registerCommand('otak-proxy.importProxy', async () => {
            const detectedProxy = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Detecting system proxy...',
                cancellable: false
            }, async () => {
                return await detectSystemProxySettings();
            });

            const state = await getProxyState(context);

            if (detectedProxy) {
                // Requirement 2.3: Display sanitized proxy URL to user
                const sanitizedProxy = sanitizer.maskPassword(detectedProxy);
                const action = await vscode.window.showInformationMessage(
                    `Found system proxy: ${sanitizedProxy}`,
                    'Use Auto Mode',
                    'Test First',
                    'Save as Manual',
                    'Cancel'
                );

                if (action === 'Test First') {
                    const testResult = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Testing proxy...',
                        cancellable: false
                    }, async () => {
                        return await testProxyConnection(detectedProxy);
                    });

                    if (testResult.success) {
                        const useAction = await vscode.window.showInformationMessage(
                            'Proxy works! How would you like to use it?',
                            'Auto Mode',
                            'Save as Manual',
                            'Cancel'
                        );

                        if (useAction === 'Auto Mode') {
                            if (validateProxyUrl(detectedProxy)) {
                                state.autoProxyUrl = detectedProxy;
                                state.mode = ProxyMode.Auto;
                                await saveProxyState(context, state);
                                await applyProxySettings(detectedProxy, true, context);
                                updateStatusBar(state);
                                await startSystemProxyMonitoring(context);
                                userNotifier.showSuccess(`Switched to Auto mode: ${sanitizeProxyUrl(detectedProxy)}`);
                            } else {
                                userNotifier.showError(
                                    'Invalid proxy URL format detected',
                                    [
                                        'The detected system proxy has an invalid format',
                                        'Check your system/browser proxy settings',
                                        'Try configuring a manual proxy instead'
                                    ]
                                );
                            }
                        } else if (useAction === 'Save as Manual') {
                            if (validateProxyUrl(detectedProxy)) {
                                state.manualProxyUrl = detectedProxy;
                                state.mode = ProxyMode.Manual;
                                await saveProxyState(context, state);
                                await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                                await applyProxySettings(detectedProxy, true, context);
                                updateStatusBar(state);
                                userNotifier.showSuccess(`Saved as manual proxy: ${sanitizeProxyUrl(detectedProxy)}`);
                            } else {
                                userNotifier.showError(
                                    'Invalid proxy URL format detected',
                                    [
                                        'The detected system proxy has an invalid format',
                                        'Check your system/browser proxy settings',
                                        'Try configuring a manual proxy instead'
                                    ]
                                );
                            }
                        }
                    } else {
                        userNotifier.showError(
                            "Detected proxy doesn't work",
                            [
                                'The proxy was detected but connection test failed',
                                'Verify the proxy server is running',
                                'Check your network connectivity',
                                'Try a different proxy configuration'
                            ]
                        );
                    }
                } else if (action === 'Use Auto Mode') {
                    if (validateProxyUrl(detectedProxy)) {
                        state.autoProxyUrl = detectedProxy;
                        state.mode = ProxyMode.Auto;
                        await saveProxyState(context, state);
                        await applyProxySettings(detectedProxy, true, context);
                        updateStatusBar(state);
                        await startSystemProxyMonitoring(context);
                        userNotifier.showSuccess(`Switched to Auto mode: ${sanitizeProxyUrl(detectedProxy)}`);
                    } else {
                        userNotifier.showError(
                            'Invalid proxy URL format detected',
                            [
                                'The detected system proxy has an invalid format',
                                'Check your system/browser proxy settings',
                                'Try configuring a manual proxy instead'
                            ]
                        );
                    }
                } else if (action === 'Save as Manual') {
                    if (validateProxyUrl(detectedProxy)) {
                        state.manualProxyUrl = detectedProxy;
                        await saveProxyState(context, state);
                        await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                        updateStatusBar(state);
                        userNotifier.showSuccess(`Saved as manual proxy: ${sanitizeProxyUrl(detectedProxy)}`);
                    } else {
                        userNotifier.showError(
                            'Invalid proxy URL format detected',
                            [
                                'The detected system proxy has an invalid format',
                                'Check your system/browser proxy settings',
                                'Try configuring a manual proxy instead'
                            ]
                        );
                    }
                }
            } else {
                userNotifier.showWarning('No system proxy detected. Check your system/browser proxy settings.');
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
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
        })
    );

    // Listen for window focus to check system proxy changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(async (windowState) => {
            if (windowState.focused) {
                const state = await getProxyState(context);
                if (state.mode === ProxyMode.Auto) {
                    await checkAndUpdateSystemProxy(context);
                }
            }
        })
    );
}

/**
 * Disables proxy settings across all configuration targets
 * Requirement 2.5: Use ErrorAggregator and UserNotifier for comprehensive error handling
 */
async function disableProxySettings(context?: vscode.ExtensionContext): Promise<boolean> {
    const errorAggregator = new ErrorAggregator();
    
    let gitSuccess = false;
    let vscodeSuccess = false;

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

    // Track configuration state if context is provided
    if (context) {
        try {
            const state = await getProxyState(context);
            state.gitConfigured = false;
            state.vscodeConfigured = false;
            state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
            await saveProxyState(context, state);
        } catch (error) {
            Logger.error('Failed to update configuration state tracking:', error);
        }
    }

    const success = gitSuccess && vscodeSuccess;
    
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
        userNotifier.showSuccess('Proxy disabled');
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

    // Track configuration state if context is provided
    if (context) {
        try {
            const state = await getProxyState(context);
            state.gitConfigured = gitSuccess;
            state.vscodeConfigured = vscodeSuccess;
            state.lastError = errorAggregator.hasErrors() ? errorAggregator.formatErrors() : undefined;
            await saveProxyState(context, state);
        } catch (error) {
            // Requirement 4.4: If we can't save state, log but don't fail the operation
            Logger.error('Failed to update configuration state tracking:', error);
        }
    }

    const success = gitSuccess && vscodeSuccess;
    
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
        userNotifier.showSuccess(`Proxy configured: ${sanitizedUrl}`);
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


function updateStatusBar(state: ProxyState) {
    if (!statusBarItem) {
        Logger.error('Status bar item not initialized');
        return;
    }

    const activeUrl = getActiveProxyUrl(state);
    let text = '';
    let statusText = '';

    switch (state.mode) {
        case ProxyMode.Auto:
            if (activeUrl) {
                text = `$(sync~spin) Auto: ${activeUrl}`;
                statusText = `Auto Mode - Using system proxy: ${activeUrl}`;
            } else {
                text = `$(sync~spin) Auto: No system proxy`;
                statusText = `Auto Mode - No system proxy detected`;
            }
            break;
        case ProxyMode.Manual:
            if (activeUrl) {
                text = `$(plug) Manual: ${activeUrl}`;
                statusText = `Manual Mode - Using: ${activeUrl}`;
            } else {
                text = `$(plug) Manual: Not configured`;
                statusText = `Manual Mode - No proxy configured`;
            }
            break;
        case ProxyMode.Off:
        default:
            text = '$(circle-slash) Proxy: Off';
            statusText = 'Proxy disabled';
            break;
    }

    statusBarItem.text = text;

    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    tooltip.appendMarkdown(`**Proxy Configuration**\n\n`);
    tooltip.appendMarkdown(`**Current Mode:** ${state.mode.toUpperCase()}\n\n`);
    tooltip.appendMarkdown(`**Status:** ${statusText}\n\n`);

    if (state.manualProxyUrl) {
        tooltip.appendMarkdown(`**Manual Proxy:** ${state.manualProxyUrl}\n\n`);
    }
    if (state.autoProxyUrl) {
        tooltip.appendMarkdown(`**System Proxy:** ${state.autoProxyUrl}\n\n`);
    }

    tooltip.appendMarkdown(`---\n\n`);
    tooltip.appendMarkdown(`$(sync) [Toggle Mode](command:otak-proxy.toggleProxy) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(gear) [Configure Manual](command:otak-proxy.configureUrl) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(cloud-download) [Import System](command:otak-proxy.importProxy) &nbsp;&nbsp; `);
    tooltip.appendMarkdown(`$(debug-start) [Test Proxy](command:otak-proxy.testProxy)`);

    statusBarItem.tooltip = tooltip;
    statusBarItem.show();
}

export async function deactivate() {
    await stopSystemProxyMonitoring();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
