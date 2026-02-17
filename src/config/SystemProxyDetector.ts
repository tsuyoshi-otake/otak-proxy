import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { Logger } from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Detection source types
 */
export type DetectionSource = 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;

/**
 * Result of proxy detection with source information
 */
export interface ProxyDetectionWithSource {
    proxyUrl: string | null;
    source: DetectionSource;
}

/**
 * SystemProxyDetector handles detection of system proxy settings across different platforms.
 * It validates detected proxy URLs and provides graceful fallback when detection fails.
 *
 * Requirements covered:
 * - 7.1: Detection source priority
 * - 7.2: Fallback on failure
 * - 7.3: Return null when all sources fail
 * - 7.4: Dynamic priority update
 */
export class SystemProxyDetector {
    private validator: ProxyUrlValidator;
    private detectionSourcePriority: string[];
    private readonly timeoutMs = 5000;

    constructor(detectionSourcePriority?: string[]) {
        this.validator = new ProxyUrlValidator();
        this.detectionSourcePriority = detectionSourcePriority || ['environment', 'vscode', 'platform'];
    }

    private async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
        return execFileAsync(command, args, {
            timeout: this.timeoutMs,
            encoding: 'utf8',
            windowsHide: true
        });
    }

    /**
     * Updates the detection source priority
     *
     * @param priority - Array of source names in priority order
     */
    updateDetectionPriority(priority: string[]): void {
        if (priority && priority.length > 0) {
            this.detectionSourcePriority = priority;
            Logger.info('Detection priority updated:', priority);
        }
    }

    /**
     * Detects system proxy settings for the current platform.
     * Validates detected proxy URLs before returning them.
     * Returns null if no proxy is detected or if detection fails.
     *
     * @returns Promise<string | null> - Detected and validated proxy URL, or null
     */
    async detectSystemProxy(): Promise<string | null> {
        const result = await this.detectSystemProxyWithSource();
        return result.proxyUrl;
    }

    /**
     * Detects system proxy settings with source information.
     * Uses configured priority order for detection sources.
     * Validates detected proxy URLs before returning them.
     *
     * @returns Promise<ProxyDetectionWithSource> - Detection result with source info
     */
    async detectSystemProxyWithSource(): Promise<ProxyDetectionWithSource> {
        try {
            for (const source of this.detectionSourcePriority) {
                const result = await this.detectFromSource(source);
                if (result.proxyUrl !== null) {
                    return result;
                }
            }

            return { proxyUrl: null, source: null };
        } catch (error) {
            Logger.error('System proxy detection failed:', error);
            return { proxyUrl: null, source: null };
        }
    }

    /**
     * Detects proxy from a specific source
     *
     * @param source - The detection source to use
     * @returns Promise<ProxyDetectionWithSource> - Detection result
     */
    private async detectFromSource(source: string): Promise<ProxyDetectionWithSource> {
        try {
            switch (source) {
                case 'environment': {
                    const envProxy = this.detectFromEnvironment();
                    if (envProxy && this.validateDetectedProxy(envProxy)) {
                        return { proxyUrl: envProxy, source: 'environment' };
                    }
                    if (envProxy) {
                        Logger.warn('Environment proxy failed validation:', envProxy);
                    }
                    break;
                }

                case 'vscode': {
                    const vscodeProxy = this.detectFromVSCode();
                    if (vscodeProxy && this.validateDetectedProxy(vscodeProxy)) {
                        return { proxyUrl: vscodeProxy, source: 'vscode' };
                    }
                    if (vscodeProxy) {
                        Logger.warn('VSCode proxy failed validation:', vscodeProxy);
                    }
                    break;
                }

                case 'platform': {
                    const platformResult = await this.detectFromPlatformWithSource();
                    if (platformResult.proxyUrl && this.validateDetectedProxy(platformResult.proxyUrl)) {
                        return platformResult;
                    }
                    if (platformResult.proxyUrl) {
                        Logger.warn('Platform proxy failed validation:', platformResult.proxyUrl);
                    }
                    break;
                }

                default:
                    Logger.warn(`Unknown detection source: ${source}`);
            }
        } catch (error) {
            Logger.warn(`Detection from source '${source}' failed:`, error);
        }

        return { proxyUrl: null, source: null };
    }

    /**
     * Detects proxy using platform-specific methods with source information.
     *
     * @returns Promise<ProxyDetectionWithSource> - Detection result with platform source
     */
    private async detectFromPlatformWithSource(): Promise<ProxyDetectionWithSource> {
        try {
            switch (process.platform) {
                case 'win32': {
                    const proxy = await this.detectWindowsProxy();
                    return { proxyUrl: proxy, source: proxy ? 'windows' : null };
                }
                case 'darwin': {
                    const proxy = await this.detectMacOSProxy();
                    return { proxyUrl: proxy, source: proxy ? 'macos' : null };
                }
                case 'linux': {
                    const proxy = await this.detectLinuxProxy();
                    return { proxyUrl: proxy, source: proxy ? 'linux' : null };
                }
                default:
                    Logger.warn(`Unsupported platform for proxy detection: ${process.platform}`);
                    return { proxyUrl: null, source: null };
            }
        } catch (error) {
            Logger.error(`Platform-specific proxy detection failed for ${process.platform}:`, error);
            return { proxyUrl: null, source: null };
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
     * Detects proxy on Windows using registry queries.
     * 
     * @returns Promise<string | null> - Windows proxy URL, or null
     */
    private async detectWindowsProxy(): Promise<string | null> {
        try {
            // First check if proxy is enabled
            const { stdout: enabledOutput } = await this.exec('reg', [
                'query',
                'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                '/v',
                'ProxyEnable'
            ]);
            const enableMatch = enabledOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);

            if (enableMatch && enableMatch[1] === '1') {
                // Proxy is enabled, get the server
                const { stdout } = await this.exec('reg', [
                    'query',
                    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                    '/v',
                    'ProxyServer'
                ]);
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
                const { stdout } = await this.exec('networksetup', ['-getwebproxy', iface]);
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
                Logger.debug(`Interface ${iface} not available or failed:`, error);
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
            const { stdout: mode } = await this.exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
            
            if (mode.includes('manual')) {
                const { stdout: host } = await this.exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'host']);
                const { stdout: port } = await this.exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']);

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
