import { Logger } from '../utils/Logger';
import type { ProxyCapability, ProxyIssue, ProxyValueKind } from '../core/v3Types';
import type { ProxyDetectionWithSource } from './SystemProxyDetector';
import { createUnsupportedAutoConfigIssue } from '../diagnostics/unsupportedAutoConfig';

export type CommandExecutor = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * Platform observation before source is attached. Reuses v3 kind/capability so
 * Auto and Diagnose share one representation (#58).
 */
export interface PlatformProxyObservation {
    proxyUrl: string | null;
    kind: ProxyValueKind;
    capability: ProxyCapability;
    issue?: ProxyIssue;
}

const FALLBACK_MACOS_SERVICES = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

/**
 * `<name>    REG_<TYPE>    <value>` as printed by `reg query`. Same contract as
 * WindowsProxyDiagnostics — static, no value name interpolated into a regex.
 */
const REG_VALUE_LINE_PATTERN = /^\s*(\S+)\s+REG_\w+\s+(.+)$/i;

export async function detectPlatformProxyWithSource(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        switch (process.platform) {
            case 'win32':
                return attachSource(await detectWindowsProxy(exec), 'windows');
            case 'darwin':
                return attachSource(await detectMacOSProxy(exec), 'macos');
            case 'linux':
                return attachSource(await detectLinuxProxy(exec), 'linux');
            default:
                Logger.warn(`Unsupported platform for proxy detection: ${process.platform}`);
                return { proxyUrl: null, source: null };
        }
    } catch (error) {
        Logger.error(`Platform-specific proxy detection failed for ${process.platform}:`, error);
        return { proxyUrl: null, source: null };
    }
}

function attachSource(
    observation: PlatformProxyObservation,
    source: Exclude<ProxyDetectionWithSource['source'], 'environment' | 'vscode' | null>
): ProxyDetectionWithSource {
    if (observation.capability === 'unsupported' && (observation.kind === 'pac' || observation.kind === 'wpad')) {
        return {
            proxyUrl: null,
            source,
            kind: observation.kind,
            capability: observation.capability,
            issue: observation.issue
        };
    }

    if (observation.proxyUrl) {
        return {
            proxyUrl: observation.proxyUrl,
            source,
            kind: observation.kind,
            capability: observation.capability
        };
    }

    return { proxyUrl: null, source: null, kind: observation.kind, capability: observation.capability };
}

function noneObservation(): PlatformProxyObservation {
    return { proxyUrl: null, kind: 'direct', capability: 'supported' };
}

function parseRegValue(stdout: string, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const line of stdout.split(/\r?\n/)) {
        const match = REG_VALUE_LINE_PATTERN.exec(line);
        if (match && match[1].toLowerCase() === target) {
            return match[2].trim();
        }
    }
    return undefined;
}

function dwordIsEnabled(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    return /0x0*1\b/i.test(value) || value === '1';
}

export async function detectWindowsProxy(exec: CommandExecutor): Promise<PlatformProxyObservation> {
    try {
        // Query the whole key once: it returns ProxyEnable, ProxyServer,
        // AutoConfigURL, and AutoDetect, so this halves the child processes
        // spawned on every detection cycle.
        const { stdout } = await exec('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
        ]);

        const proxyEnable = dwordIsEnabled(parseRegValue(stdout, 'ProxyEnable'));
        const proxyServer = parseRegValue(stdout, 'ProxyServer');
        const autoConfigUrl = parseRegValue(stdout, 'AutoConfigURL');
        const autoDetect = dwordIsEnabled(parseRegValue(stdout, 'AutoDetect'));

        if (proxyEnable && proxyServer) {
            const parsed = parseWindowsProxyValue(proxyServer);
            if (parsed) {
                return { proxyUrl: parsed, kind: 'singleProxy', capability: 'supported' };
            }
        }

        if (autoConfigUrl) {
            return {
                proxyUrl: null,
                kind: 'pac',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'windows.wininet.pac',
                    targetId: 'windows.wininet',
                    targetHost: 'windowsHost',
                    source: 'registry',
                    kind: 'pac',
                    autoConfigUrl
                })
            };
        }

        // Registry AutoDetect=1 without AutoConfigURL. This is a bit observation
        // only — we do not claim WPAD was the effective path on a real machine.
        if (autoDetect) {
            return {
                proxyUrl: null,
                kind: 'wpad',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'windows.wininet.wpad',
                    targetId: 'windows.wininet',
                    targetHost: 'windowsHost',
                    source: 'registry',
                    kind: 'wpad',
                    evidence: { observation: 'registry AutoDetect' }
                })
            };
        }

        return noneObservation();
    } catch (error) {
        Logger.error('Windows registry query failed:', error);
        return noneObservation();
    }
}

function parseWindowsProxyValue(proxyValue: string): string | null {
    if (!proxyValue.includes('=')) {
        return proxyValue.startsWith('http') ? proxyValue : `http://${proxyValue}`;
    }

    const parts = proxyValue.split(';');
    for (const part of parts) {
        if (part.startsWith('http=') || part.startsWith('https=')) {
            const url = part.split('=')[1];
            return url.startsWith('http') ? url : `http://${url}`;
        }
    }

    return null;
}

/**
 * Parses `networksetup -listallnetworkservices`. Disabled services are prefixed
 * with `*`. The header line mentions "asterisk" / "disabled".
 *
 * Residual: this is the configured service list, not a verified Darwin
 * effective-path / default-route selection. No macOS lab was run.
 */
export function parseMacOSNetworkServices(stdout: string): string[] {
    const services: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        if (/asterisk/i.test(line) && /disabled/i.test(line)) {
            continue;
        }
        if (line.startsWith('*')) {
            continue;
        }
        services.push(line);
    }
    return services;
}

async function listMacOSNetworkServices(exec: CommandExecutor): Promise<string[]> {
    try {
        const { stdout } = await exec('networksetup', ['-listallnetworkservices']);
        const services = parseMacOSNetworkServices(stdout);
        if (services.length > 0) {
            return services;
        }
    } catch (error) {
        Logger.debug('networksetup -listallnetworkservices failed; falling back to well-known names:', error);
    }
    return [...FALLBACK_MACOS_SERVICES];
}

function parseMacOSProxyBlock(stdout: string): { enabled: boolean; server?: string; port?: string } {
    const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
    const serverMatch = stdout.match(/Server:\s*(.+)/);
    const portMatch = stdout.match(/Port:\s*(\d+)/);
    return {
        enabled: enabledMatch?.[1] === 'Yes',
        server: serverMatch?.[1]?.trim(),
        port: portMatch?.[1]?.trim()
    };
}

function parseMacOSAutoProxy(stdout: string): { enabled: boolean; url?: string } {
    const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
    const urlMatch = stdout.match(/URL:\s*(.+)/);
    const url = urlMatch?.[1]?.trim();
    const usable = url && url !== '(null)' ? url : undefined;
    return {
        enabled: enabledMatch?.[1] === 'Yes',
        url: usable
    };
}

export async function detectMacOSProxy(exec: CommandExecutor): Promise<PlatformProxyObservation> {
    const services = await listMacOSNetworkServices(exec);
    let firstPac: PlatformProxyObservation | undefined;

    for (const iface of services) {
        try {
            const web = parseMacOSProxyBlock((await exec('networksetup', ['-getwebproxy', iface])).stdout);
            if (web.enabled && web.server && web.port) {
                return {
                    proxyUrl: `http://${web.server}:${web.port}`,
                    kind: 'singleProxy',
                    capability: 'supported'
                };
            }
        } catch (error) {
            Logger.debug(`Interface ${iface} getwebproxy not available or failed:`, error);
        }

        try {
            const secure = parseMacOSProxyBlock((await exec('networksetup', ['-getsecurewebproxy', iface])).stdout);
            if (secure.enabled && secure.server && secure.port) {
                return {
                    proxyUrl: `http://${secure.server}:${secure.port}`,
                    kind: 'singleProxy',
                    capability: 'supported'
                };
            }
        } catch (error) {
            Logger.debug(`Interface ${iface} getsecurewebproxy not available or failed:`, error);
        }

        if (firstPac) {
            continue;
        }

        try {
            const auto = parseMacOSAutoProxy((await exec('networksetup', ['-getautoproxyurl', iface])).stdout);
            if (auto.enabled && auto.url) {
                firstPac = {
                    proxyUrl: null,
                    kind: 'pac',
                    capability: 'unsupported',
                    issue: createUnsupportedAutoConfigIssue({
                        id: 'macos.autoproxy.pac',
                        targetId: 'macos.network',
                        targetHost: 'workspaceHost',
                        source: 'networksetup',
                        kind: 'pac',
                        autoConfigUrl: auto.url,
                        evidence: { service: iface }
                    })
                };
            }
        } catch (error) {
            Logger.debug(`Interface ${iface} getautoproxyurl not available or failed:`, error);
        }
    }

    return firstPac ?? noneObservation();
}

export async function detectLinuxProxy(exec: CommandExecutor): Promise<PlatformProxyObservation> {
    try {
        const { stdout: mode } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);

        if (mode.includes('manual')) {
            const { stdout: host } = await exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'host']);
            const { stdout: port } = await exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']);
            const cleanHost = host.replace(/'/g, '').trim();
            const cleanPort = port.trim();

            return cleanHost && cleanPort !== '0'
                ? { proxyUrl: `http://${cleanHost}:${cleanPort}`, kind: 'singleProxy', capability: 'supported' }
                : noneObservation();
        }

        if (mode.includes('auto')) {
            let autoConfigUrl: string | undefined;
            try {
                const { stdout: rawUrl } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url']);
                const cleaned = rawUrl.replace(/'/g, '').trim();
                autoConfigUrl = cleaned || undefined;
            } catch (error) {
                Logger.debug('GNOME autoconfig-url read failed:', error);
            }

            return {
                proxyUrl: null,
                kind: 'pac',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'linux.gnome.auto',
                    targetId: 'linux.gnome',
                    targetHost: 'workspaceHost',
                    source: 'gsettings',
                    kind: 'pac',
                    autoConfigUrl
                })
            };
        }

        return noneObservation();
    } catch (error) {
        Logger.error('Linux gsettings query failed (gsettings not available or not GNOME):', error);
        return noneObservation();
    }
}
