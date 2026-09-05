import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { Logger } from '../utils/Logger';
import { detectPlatformProxyWithSource } from './PlatformProxyDetection';
import { buildDetectedProxyValue } from './DetectedProxyValue';
import { getProxyPublicUrl } from '../utils/ProxyStateSanitizer';
import type { ProxyCapability, ProxyIssue, ProxyValueKind } from '../core/v3Types';

const execFileAsync = promisify(execFile);

/**
 * Detection source types
 */
export type DetectionSource = 'environment' | 'vscode' | 'windows' | 'macos' | 'linux' | null;

/**
 * Result of proxy detection with source information.
 * `kind` / `capability` reuse the v3 value-kind and capability enums so PAC/WPAD
 * can be reported as detected-but-unsupported instead of collapsing to none (#58).
 */
export interface ProxyDetectionWithSource {
    proxyUrl: string | null;
    source: DetectionSource;
    kind?: ProxyValueKind;
    httpUrl?: string;
    httpsUrl?: string;
    bypass?: string;
    capability?: ProxyCapability;
    issue?: ProxyIssue;
}

export function isUnsupportedAutoConfig(
    result: Pick<ProxyDetectionWithSource, 'kind' | 'capability'>
): boolean {
    return result.capability === 'unsupported' && (result.kind === 'pac' || result.kind === 'wpad');
}

/**
 * The proxy URL currently applied by this extension, with the provenance
 * of that URL. `source` is undefined when provenance is unknown (state
 * persisted by an older extension version).
 */
export interface AppliedProxyInfo {
    url: string;
    source?: string;
}

/**
 * Supplies the currently applied proxy so detection can recognize its own
 * VS Code `http.proxy` write (issue #29 echo suppression).
 */
export type AppliedProxyProvider = () => Promise<AppliedProxyInfo | undefined>;

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
    private appliedProxyProvider?: AppliedProxyProvider;

    constructor(detectionSourcePriority?: string[]) {
        this.validator = new ProxyUrlValidator();
        this.detectionSourcePriority = detectionSourcePriority || ['environment', 'vscode', 'platform'];
    }

    /**
     * Registers the provider used to recognize the extension's own
     * VS Code `http.proxy` write during detection (issue #29).
     */
    setAppliedProxyProvider(provider: AppliedProxyProvider | undefined): void {
        this.appliedProxyProvider = provider;
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
                if (result.proxyUrl !== null || isUnsupportedAutoConfig(result)) {
                    return result;
                }
            }

            return emptyDetection();
        } catch (error) {
            Logger.error('System proxy detection failed:', error);
            return emptyDetection();
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
            return emptyDetection();
        }
    }

    private async detectKnownSource(source: string): Promise<ProxyDetectionWithSource> {
        switch (source) {
            case 'environment':
                return this.validateDetectedValue(this.detectFromEnvironment(), 'Environment');
            case 'vscode': {
                const result = this.validateDetectedValue(this.detectFromVSCode(), 'VSCode');
                if (result.proxyUrl && await this.isSelfWrittenVSCodeValue(result.proxyUrl)) {
                    Logger.info('Ignoring VSCode http.proxy: it matches the proxy this extension applied (echo suppression)');
                    return emptyDetection();
                }
                return result;
            }
            case 'platform':
                return this.validateDetectedValue(
                    await detectPlatformProxyWithSource((command, args) => this.exec(command, args)),
                    'Platform'
                );
            default:
                Logger.warn(`Unknown detection source: ${source}`);
                return emptyDetection();
        }
    }

    private validateDetectedValue(result: ProxyDetectionWithSource, label: string): ProxyDetectionWithSource {
        if (isUnsupportedAutoConfig(result)) {
            return result;
        }

        const httpUrl = this.validOptionalUrl(result.httpUrl, `${label} HTTP`);
        const httpsUrl = this.validOptionalUrl(result.httpsUrl, `${label} HTTPS`);
        if (httpUrl || httpsUrl) {
            return buildDetectedProxyValue({
                http: httpUrl,
                https: httpsUrl,
                bypass: result.bypass,
                source: result.source
            });
        }

        if (!result.proxyUrl) {
            return result.bypass
                ? { ...emptyDetection(), bypass: result.bypass, kind: 'direct' }
                : emptyDetection();
        }

        if (this.validateDetectedProxy(result.proxyUrl)) {
            return buildDetectedProxyValue({
                http: result.proxyUrl,
                https: result.proxyUrl,
                bypass: result.bypass,
                source: result.source
            });
        }

        Logger.warn(`${label} proxy failed validation:`, result.proxyUrl);
        return emptyDetection();
    }

    private validOptionalUrl(url: string | undefined, label: string): string | undefined {
        if (!url) {
            return undefined;
        }
        if (this.validateDetectedProxy(url)) {
            return url;
        }
        Logger.warn(`${label} proxy failed validation:`, url);
        return undefined;
    }

    /**
     * Decides whether a `http.proxy` value read from VS Code settings is an
     * echo of the proxy this extension itself applied (issue #29).
     *
     * Suppression requires ALL of:
     * - the escape-hatch setting `otakProxy.ignoreSelfWrittenVSCodeProxy` is not false,
     * - a registered provider reports a currently applied proxy,
     * - its provenance is known and is NOT 'vscode' (undefined provenance may be a
     *   hand-set `http.proxy` that predates this extension — never suppress those),
     * - the candidate equals the applied URL in credential-stripped public form.
     */
    private async isSelfWrittenVSCodeValue(candidate: string): Promise<boolean> {
        if (!this.appliedProxyProvider || !this.isEchoSuppressionEnabled()) {
            return false;
        }

        try {
            const applied = await this.appliedProxyProvider();
            if (!applied?.url || !applied.source || applied.source === 'vscode') {
                return false;
            }

            const candidatePublic = getProxyPublicUrl(candidate) ?? candidate;
            const appliedPublic = getProxyPublicUrl(applied.url) ?? applied.url;
            return candidatePublic === appliedPublic;
        } catch (error) {
            Logger.warn('Applied proxy provider failed; skipping echo suppression:', error);
            return false;
        }
    }

    private isEchoSuppressionEnabled(): boolean {
        try {
            const value = vscode.workspace.getConfiguration('otakProxy').get<boolean>('ignoreSelfWrittenVSCodeProxy', true);
            // Unit tests run against a vscode shim whose get() ignores the
            // default argument, so undefined must mean "enabled".
            return value !== false;
        } catch {
            return true;
        }
    }

    /**
     * Detects proxy from environment variables.
     * Checks HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy.
     * 
     * @returns string | null - Proxy URL from environment, or null
     */
    private detectFromEnvironment(): ProxyDetectionWithSource {
        return buildDetectedProxyValue({
            http: process.env.HTTP_PROXY || process.env.http_proxy,
            https: process.env.HTTPS_PROXY || process.env.https_proxy,
            bypass: process.env.NO_PROXY || process.env.no_proxy,
            source: 'environment'
        });
    }

    /**
     * Detects proxy from VSCode configuration.
     * 
     * @returns string | null - Proxy URL from VSCode config, or null
     */
    private detectFromVSCode(): ProxyDetectionWithSource {
        try {
            const vscodeProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
            return vscodeProxy
                ? buildDetectedProxyValue({ http: vscodeProxy, https: vscodeProxy, source: 'vscode' })
                : emptyDetection();
        } catch (error) {
            Logger.error('Failed to read VSCode proxy configuration:', error);
            return emptyDetection();
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

export function emptyDetection(): ProxyDetectionWithSource {
    return { proxyUrl: null, source: null };
}
