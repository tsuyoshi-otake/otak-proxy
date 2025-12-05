import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProxyUrlValidator } from './validation/ProxyUrlValidator';

const execAsync = promisify(exec);
const validator = new ProxyUrlValidator();

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
}

function validateProxyUrl(url: string): boolean {
    const result = validator.validate(url);
    if (!result.isValid && result.errors.length > 0) {
        console.error('Proxy URL validation failed:', result.errors.join(', '));
    }
    return result.isValid;
}

function sanitizeProxyUrl(url: string): string {
    // Remove potentially dangerous characters for shell commands
    // URL class already validates the URL structure
    try {
        const parsed = new URL(url);
        // Mask password if present for security
        if (parsed.password) {
            parsed.password = '****';
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function escapeShellArg(arg: string): string {
    // Escape shell special characters for safety
    // Use double quotes and escape necessary characters
    return arg.replace(/["\\$`]/g, '\\$&');
}

async function getProxyState(context: vscode.ExtensionContext): Promise<ProxyState> {
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
            lastSystemProxyCheck: undefined
        };
    }
    return state;
}

async function saveProxyState(context: vscode.ExtensionContext, state: ProxyState): Promise<void> {
    await context.globalState.update('proxyState', state);
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

    if (state.mode === ProxyMode.Auto) {
        const previousProxy = state.autoProxyUrl;
        state.autoProxyUrl = detectedProxy || undefined;

        if (previousProxy !== state.autoProxyUrl) {
            // System proxy changed, update everything
            await saveProxyState(context, state);
            await applyProxySettings(state.autoProxyUrl || '', true);
            updateStatusBar(state);

            if (state.autoProxyUrl) {
                vscode.window.showInformationMessage(`System proxy changed: ${sanitizeProxyUrl(state.autoProxyUrl)}`);
            } else if (previousProxy) {
                vscode.window.showInformationMessage('System proxy removed');
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

async function testProxyConnection(proxyUrl: string): Promise<boolean> {
    try {
        const https = require('https');
        const http = require('http');
        const url = require('url');

        const proxyParsed = url.parse(proxyUrl);
        const testUrls = [
            'https://www.github.com',
            'https://www.microsoft.com',
            'https://www.google.com'
        ];

        // Test connection through proxy
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

                    req.on('error', () => {
                        resolve(false);
                    });

                    req.on('timeout', () => {
                        req.destroy();
                        resolve(false);
                    });

                    req.end();
                });

                if (result) {
                    return true; // At least one test URL worked
                }
            } catch {
                continue; // Try next URL
            }
        }

        return false;
    } catch (error) {
        console.error('Proxy test error:', error);
        return false;
    }
}

async function detectSystemProxySettings(): Promise<string | null> {
    try {
        // First, check environment variables (works on all platforms)
        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

        if (httpProxy || httpsProxy) {
            return httpProxy || httpsProxy || null;
        }

        // Check existing VSCode proxy setting
        const vscodeProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
        if (vscodeProxy) {
            return vscodeProxy;
        }

        // Platform-specific detection
        if (process.platform === 'win32') {
            // Windows: Try to get proxy from registry
            try {
                // First check if proxy is enabled
                const { stdout: enabledOutput } = await execAsync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable');
                const enableMatch = enabledOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);

                if (enableMatch && enableMatch[1] === '1') {
                    // Proxy is enabled, get the server
                    const { stdout } = await execAsync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer');
                    const match = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);
                    if (match && match[1]) {
                        // Windows proxy format might be "http=proxy:port;https=proxy:port"
                        const proxyValue = match[1].trim();
                        if (proxyValue.includes('=')) {
                            const parts = proxyValue.split(';');
                            for (const part of parts) {
                                if (part.startsWith('http=') || part.startsWith('https=')) {
                                    const url = part.split('=')[1];
                                    return url.startsWith('http') ? url : `http://${url}`;
                                }
                            }
                        } else {
                            return proxyValue.startsWith('http') ? proxyValue : `http://${proxyValue}`;
                        }
                    }
                }
            } catch {
                // Registry query failed, continue
            }
        } else if (process.platform === 'darwin') {
            // macOS: Try multiple network interfaces
            const interfaces = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

            for (const iface of interfaces) {
                try {
                    const { stdout } = await execAsync(`networksetup -getwebproxy "${iface}"`);
                    const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
                    const serverMatch = stdout.match(/Server:\s*(.+)/);
                    const portMatch = stdout.match(/Port:\s*(\d+)/);

                    if (enabledMatch && enabledMatch[1] === 'Yes' && serverMatch && portMatch) {
                        const server = serverMatch[1].trim();
                        const port = portMatch[1].trim();
                        return `http://${server}:${port}`;
                    }
                } catch {
                    // This interface might not exist, try next
                    continue;
                }
            }
        } else if (process.platform === 'linux') {
            // Linux: Check gsettings for GNOME
            try {
                const { stdout: mode } = await execAsync('gsettings get org.gnome.system.proxy mode');
                if (mode.includes('manual')) {
                    const { stdout: host } = await execAsync('gsettings get org.gnome.system.proxy.http host');
                    const { stdout: port } = await execAsync('gsettings get org.gnome.system.proxy.http port');

                    const cleanHost = host.replace(/'/g, '').trim();
                    const cleanPort = port.trim();

                    if (cleanHost && cleanPort !== '0') {
                        return `http://${cleanHost}:${cleanPort}`;
                    }
                }
            } catch {
                // gsettings not available or not GNOME
            }
        }

        return null;
    } catch {
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
            await applyProxySettings(detectedProxy, true);
            updateStatusBar(state);
            vscode.window.showInformationMessage(`Using system proxy: ${sanitizeProxyUrl(detectedProxy)}`);
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
                    await applyProxySettings(updatedState.manualProxyUrl, true);
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
                vscode.window.showErrorMessage('Invalid proxy URL format. Use format: http://proxy:8080');
                return;
            }
            state.manualProxyUrl = manualProxyUrl;
            state.mode = ProxyMode.Manual;
            await saveProxyState(context, state);

            // Also save to config for backwards compatibility
            await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', manualProxyUrl, vscode.ConfigurationTarget.Global);

            await applyProxySettings(manualProxyUrl, true);
            updateStatusBar(state);
            vscode.window.showInformationMessage(`Manual proxy configured: ${sanitizeProxyUrl(manualProxyUrl)}`);
        }
    }

    // Start monitoring if in auto mode
    if (state.mode === ProxyMode.Auto) {
        await startSystemProxyMonitoring(context);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension "otak-proxy" is now active.');

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
        await applyProxySettings(activeUrl, true);
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
                vscode.window.showInformationMessage('No system proxy detected. Switching to Off mode.');
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
        await applyProxySettings(newActiveUrl, currentState.mode !== ProxyMode.Off);
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
                    vscode.window.showErrorMessage('Invalid proxy URL format. Use format: http://proxy:8080');
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
                        await applyProxySettings(proxyUrl, true);
                    } else {
                        // Manual proxy was removed, switch to Off
                        state.mode = ProxyMode.Off;
                        await saveProxyState(context, state);
                        await applyProxySettings('', false);
                    }
                    updateStatusBar(state);
                }
            }
        })
    );

    // Proxy test command
    context.subscriptions.push(
        vscode.commands.registerCommand('otak-proxy.testProxy', async () => {
            const state = await getProxyState(context);
            const activeUrl = getActiveProxyUrl(state);

            if (!activeUrl) {
                vscode.window.showErrorMessage(`No proxy configured. Current mode: ${state.mode.toUpperCase()}`);
                return;
            }

            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Testing ${state.mode} proxy: ${activeUrl}...`,
                cancellable: false
            }, async () => {
                return await testProxyConnection(activeUrl);
            });

            if (result) {
                vscode.window.showInformationMessage(`${state.mode.toUpperCase()} proxy works: ${activeUrl}`);
            } else {
                const action = await vscode.window.showErrorMessage(
                    `Can't connect through ${state.mode} proxy: ${activeUrl}`,
                    state.mode === ProxyMode.Manual ? 'Reconfigure' : 'Check System Settings',
                    'OK'
                );

                if (action === 'Reconfigure') {
                    vscode.commands.executeCommand('otak-proxy.configureUrl');
                } else if (action === 'Check System Settings') {
                    vscode.window.showInformationMessage('Check your system/browser proxy settings');
                }
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
                const action = await vscode.window.showInformationMessage(
                    `Found system proxy: ${detectedProxy}`,
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

                    if (testResult) {
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
                                await applyProxySettings(detectedProxy, true);
                                updateStatusBar(state);
                                await startSystemProxyMonitoring(context);
                                vscode.window.showInformationMessage(`Switched to Auto mode: ${sanitizeProxyUrl(detectedProxy)}`);
                            } else {
                                vscode.window.showErrorMessage('Invalid proxy URL format detected.');
                            }
                        } else if (useAction === 'Save as Manual') {
                            if (validateProxyUrl(detectedProxy)) {
                                state.manualProxyUrl = detectedProxy;
                                state.mode = ProxyMode.Manual;
                                await saveProxyState(context, state);
                                await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                                await applyProxySettings(detectedProxy, true);
                                updateStatusBar(state);
                                vscode.window.showInformationMessage(`Saved as manual proxy: ${sanitizeProxyUrl(detectedProxy)}`);
                            } else {
                                vscode.window.showErrorMessage('Invalid proxy URL format detected.');
                            }
                        }
                    } else {
                        vscode.window.showErrorMessage("Detected proxy doesn't work.");
                    }
                } else if (action === 'Use Auto Mode') {
                    if (validateProxyUrl(detectedProxy)) {
                        state.autoProxyUrl = detectedProxy;
                        state.mode = ProxyMode.Auto;
                        await saveProxyState(context, state);
                        await applyProxySettings(detectedProxy, true);
                        updateStatusBar(state);
                        await startSystemProxyMonitoring(context);
                        vscode.window.showInformationMessage(`Switched to Auto mode: ${sanitizeProxyUrl(detectedProxy)}`);
                    } else {
                        vscode.window.showErrorMessage('Invalid proxy URL format detected.');
                    }
                } else if (action === 'Save as Manual') {
                    if (validateProxyUrl(detectedProxy)) {
                        state.manualProxyUrl = detectedProxy;
                        await saveProxyState(context, state);
                        await vscode.workspace.getConfiguration('otakProxy').update('proxyUrl', detectedProxy, vscode.ConfigurationTarget.Global);
                        updateStatusBar(state);
                        vscode.window.showInformationMessage(`Saved as manual proxy: ${sanitizeProxyUrl(detectedProxy)}`);
                    } else {
                        vscode.window.showErrorMessage('Invalid proxy URL format detected.');
                    }
                }
            } else {
                vscode.window.showWarningMessage('No system proxy detected. Check your system/browser proxy settings.');
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
                        await applyProxySettings(newUrl, !!newUrl);
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

async function applyProxySettings(proxyUrl: string, enabled: boolean): Promise<boolean> {
    let success = true;
    const errors: string[] = [];

    try {
        await updateVSCodeProxy(enabled, proxyUrl);
    } catch (error) {
        success = false;
        errors.push(`VSCode: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
        await updateGitProxy(enabled, proxyUrl);
    } catch (error) {
        success = false;
        errors.push(`Git: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    if (!success && errors.length > 0) {
        void vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Some settings failed:\n${errors.join('\n')}`,
            cancellable: false
        }, () => new Promise(resolve => setTimeout(resolve, 7000)));
    }

    return success;
}

async function updateVSCodeProxy(enabled: boolean, proxyUrl: string) {
    try {
        await vscode.workspace.getConfiguration('http').update('proxy', enabled ? proxyUrl : "", vscode.ConfigurationTarget.Global);
        return true;
    } catch (error) {
        console.error('VSCode proxy setting error:', error);
        throw new Error('Failed to update VSCode proxy settings');
    }
}

async function updateGitProxy(enabled: boolean, proxyUrl: string) {
    try {
        async function checkGitConfig(key: string): Promise<boolean> {
            try {
                await execAsync(`git config --global --get ${key}`);
                return true;
            } catch {
                return false;
            }
        }

        if (enabled) {
            const escapedUrl = escapeShellArg(proxyUrl);
            await execAsync(`git config --global http.proxy "${escapedUrl}"`, { encoding: 'utf8' });
            await execAsync(`git config --global https.proxy "${escapedUrl}"`, { encoding: 'utf8' });
        } else {
            const [hasHttpProxy, hasHttpsProxy] = await Promise.all([
                checkGitConfig('http.proxy'),
                checkGitConfig('https.proxy')
            ]);

            if (hasHttpProxy || hasHttpsProxy) {
                if (hasHttpProxy) {
                    await execAsync('git config --global --unset http.proxy', { encoding: 'utf8' });
                }
                if (hasHttpsProxy) {
                    await execAsync('git config --global --unset https.proxy', { encoding: 'utf8' });
                }
            }
        }
        return true;
    } catch (error) {
        console.error('Git proxy setting error:', error);
        if (!enabled) {
            return true; // プロキシ無効化時のエラーは無視する
        }
        throw new Error('Failed to update Git proxy settings');
    }
}


function updateStatusBar(state: ProxyState) {
    if (!statusBarItem) {
        console.error('Status bar item not initialized');
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
