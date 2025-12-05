import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { Logger } from '../utils/Logger';

const execAsync = promisify(exec);

/**
 * SystemProxyDetector handles detection of system proxy settings across different platforms.
 * It validates detected proxy URLs and provides graceful fallback when detection fails.
 */
export class SystemProxyDetector {
    private validator: ProxyUrlValidator;

    constructor() {
        this.validator = new ProxyUrlValidator();
    }

    /**
     * Detects system proxy settings for the current platform.
     * Validates detected proxy URLs before returning them.
     * Returns null if no proxy is detected or if detection fails.
     * 
     * @returns Promise<string | null> - Detected and validated proxy URL, or null
     */
    async detectSystemProxy(): Promise<string | null> {
        try {
            // First, check environment variables (works on all platforms)
            const envProxy = this.detectFromEnvironment();
            if (envProxy) {
                if (this.validateDetectedProxy(envProxy)) {
                    return envProxy;
                } else {
                    Logger.warn('Environment proxy failed validation:', envProxy);
                }
            }

            // Check existing VSCode proxy setting
            const vscodeProxy = this.detectFromVSCode();
            if (vscodeProxy) {
                if (this.validateDetectedProxy(vscodeProxy)) {
                    return vscodeProxy;
                } else {
                    Logger.warn('VSCode proxy failed validation:', vscodeProxy);
                }
            }

            // Platform-specific detection
            const platformProxy = await this.detectFromPlatform();
            if (platformProxy) {
                if (this.validateDetectedProxy(platformProxy)) {
                    return platformProxy;
                } else {
                    Logger.warn('Platform proxy failed validation:', platformProxy);
                }
            }

            return null;
        } catch (error) {
            Logger.error('System proxy detection failed:', error);
            return null;
        }
    }

    /**
     * Detects proxy from environment variables.
     * Checks HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy.
     * 
     * @returns string | null - Proxy URL from environment, or null
     */
    private detectFromEnvironment(): string | null {
        const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
        
        return httpProxy || httpsProxy || null;
    }

    /**
     * Detects proxy from VSCode configuration.
     * 
     * @returns string | null - Proxy URL from VSCode config, or null
     */
    private detectFromVSCode(): string | null {
        try {
            const vscodeProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
            return vscodeProxy || null;
        } catch (error) {
            Logger.error('Failed to read VSCode proxy configuration:', error);
            return null;
        }
    }

    /**
     * Detects proxy using platform-specific methods.
     * Handles Windows registry, macOS networksetup, and Linux gsettings.
     * 
     * @returns Promise<string | null> - Detected proxy URL, or null
     */
    private async detectFromPlatform(): Promise<string | null> {
        try {
            switch (process.platform) {
                case 'win32':
                    return await this.detectWindowsProxy();
                case 'darwin':
                    return await this.detectMacOSProxy();
                case 'linux':
                    return await this.detectLinuxProxy();
                default:
                    Logger.warn(`Unsupported platform for proxy detection: ${process.platform}`);
                    return null;
            }
        } catch (error) {
            Logger.error(`Platform-specific proxy detection failed for ${process.platform}:`, error);
            return null;
        }
    }

    /**
     * Detects proxy on Windows using registry queries.
     * 
     * @returns Promise<string | null> - Windows proxy URL, or null
     */
    private async detectWindowsProxy(): Promise<string | null> {
        try {
            // First check if proxy is enabled
            const { stdout: enabledOutput } = await execAsync(
                'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable'
            );
            const enableMatch = enabledOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);

            if (enableMatch && enableMatch[1] === '1') {
                // Proxy is enabled, get the server
                const { stdout } = await execAsync(
                    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer'
                );
                const match = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);
                
                if (match && match[1]) {
                    const proxyValue = match[1].trim();
                    return this.parseWindowsProxyValue(proxyValue);
                }
            }
            
            return null;
        } catch (error) {
            Logger.error('Windows registry query failed:', error);
            return null;
        }
    }

    /**
     * Parses Windows proxy value which may be in format "http=proxy:port;https=proxy:port"
     * or simple "proxy:port".
     * 
     * @param proxyValue - Raw proxy value from Windows registry
     * @returns string | null - Parsed proxy URL, or null
     */
    private parseWindowsProxyValue(proxyValue: string): string | null {
        // Windows proxy format might be "http=proxy:port;https=proxy:port"
        if (proxyValue.includes('=')) {
            const parts = proxyValue.split(';');
            for (const part of parts) {
                if (part.startsWith('http=') || part.startsWith('https=')) {
                    const url = part.split('=')[1];
                    return url.startsWith('http') ? url : `http://${url}`;
                }
            }
            return null;
        } else {
            // Simple format: "proxy:port"
            return proxyValue.startsWith('http') ? proxyValue : `http://${proxyValue}`;
        }
    }

    /**
     * Detects proxy on macOS using networksetup command.
     * Tries multiple network interfaces (Wi-Fi, Ethernet, Thunderbolt Ethernet).
     * 
     * @returns Promise<string | null> - macOS proxy URL, or null
     */
    private async detectMacOSProxy(): Promise<string | null> {
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
            } catch (error) {
                // This interface might not exist, try next
                console.debug(`Interface ${iface} not available or failed:`, error);
                continue;
            }
        }

        return null;
    }

    /**
     * Detects proxy on Linux using gsettings (GNOME).
     * 
     * @returns Promise<string | null> - Linux proxy URL, or null
     */
    private async detectLinuxProxy(): Promise<string | null> {
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
            
            return null;
        } catch (error) {
            Logger.error('Linux gsettings query failed (gsettings not available or not GNOME):', error);
            return null;
        }
    }

    /**
     * Validates a detected proxy URL using ProxyUrlValidator.
     * Logs validation errors but doesn't throw.
     * 
     * @param url - Proxy URL to validate
     * @returns boolean - True if valid, false otherwise
     */
    private validateDetectedProxy(url: string): boolean {
        const result = this.validator.validate(url);
        
        if (!result.isValid) {
            Logger.warn('Detected proxy URL failed validation:', url);
            Logger.warn('Validation errors:', result.errors);
            return false;
        }
        
        return true;
    }
}
