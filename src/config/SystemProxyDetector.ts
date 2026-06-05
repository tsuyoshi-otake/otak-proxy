import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { Logger } from '../utils/Logger';
import { detectPlatformProxyWithSource } from './PlatformProxyDetection';

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
            return await this.detectKnownSource(source);
        } catch (error) {
            Logger.warn(`Detection from source '${source}' failed:`, error);
            return { proxyUrl: null, source: null };
        }
    }

    private async detectKnownSource(source: string): Promise<ProxyDetectionWithSource> {
        switch (source) {
            case 'environment':
                return this.validateSourceResult(this.detectFromEnvironment(), 'environment', 'Environment');
            case 'vscode':
                return this.validateSourceResult(this.detectFromVSCode(), 'vscode', 'VSCode');
            case 'platform':
                return this.validatePlatformResult(await detectPlatformProxyWithSource((command, args) => this.exec(command, args)));
            default:
                Logger.warn(`Unknown detection source: ${source}`);
                return { proxyUrl: null, source: null };
        }
    }

    private validateSourceResult(
        proxyUrl: string | null,
        source: Exclude<DetectionSource, 'windows' | 'macos' | 'linux' | null>,
        label: string
    ): ProxyDetectionWithSource {
        if (!proxyUrl) {
            return { proxyUrl: null, source: null };
        }

        if (this.validateDetectedProxy(proxyUrl)) {
            return { proxyUrl, source };
        }

        Logger.warn(`${label} proxy failed validation:`, proxyUrl);
        return { proxyUrl: null, source: null };
    }

    private validatePlatformResult(result: ProxyDetectionWithSource): ProxyDetectionWithSource {
        if (!result.proxyUrl) {
            return { proxyUrl: null, source: null };
        }

        if (this.validateDetectedProxy(result.proxyUrl)) {
            return result;
        }

        Logger.warn('Platform proxy failed validation:', result.proxyUrl);
        return { proxyUrl: null, source: null };
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
