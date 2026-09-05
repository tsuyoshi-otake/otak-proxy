import { Logger } from '../utils/Logger';
import { buildDetectedProxyValue, normalizeProxyEndpoint } from './DetectedProxyValue';
import type { ProxyDetectionWithSource } from './SystemProxyDetector';
import { createUnsupportedAutoConfigIssue } from '../diagnostics/unsupportedAutoConfig';

export type CommandExecutor = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsProxyServerParse {
    http?: string;
    https?: string;
}

const FALLBACK_MACOS_SERVICES = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];
const REG_VALUE_LINE_PATTERN = /^\s*(\S+)\s+REG_\w+\s+(.+)$/i;

function noneDetection(source: ProxyDetectionWithSource['source'] = null): ProxyDetectionWithSource {
    return { proxyUrl: null, source, kind: 'direct', capability: 'supported' };
}

export async function detectPlatformProxyWithSource(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        switch (process.platform) {
            case 'win32':
                return await detectWindowsProxy(exec);
            case 'darwin':
                return await detectMacOSProxy(exec);
            case 'linux':
                return await detectLinuxProxy(exec);
            default:
                Logger.warn(`Unsupported platform for proxy detection: ${process.platform}`);
                return { proxyUrl: null, source: null };
        }
    } catch (error) {
        Logger.error(`Platform-specific proxy detection failed for ${process.platform}:`, error);
        return { proxyUrl: null, source: null };
    }
}

const WINDOWS_INTERNET_SETTINGS_KEY =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

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

export async function detectWindowsProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        const { stdout } = await exec('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY]);
        const proxyEnable = dwordIsEnabled(parseRegValue(stdout, 'ProxyEnable'));
        const proxyServer = parseRegValue(stdout, 'ProxyServer');
        const autoConfigUrl = parseRegValue(stdout, 'AutoConfigURL');
        const autoDetect = dwordIsEnabled(parseRegValue(stdout, 'AutoDetect'));
        const bypass = parseRegValue(stdout, 'ProxyOverride');

        if (proxyEnable && proxyServer) {
            const parsed = parseWindowsProxyServer(proxyServer);
            return buildDetectedProxyValue({
                http: parsed.http,
                https: parsed.https,
                bypass,
                source: 'windows'
            });
        }

        if (autoConfigUrl) {
            return {
                proxyUrl: null,
                source: 'windows',
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

        if (autoDetect) {
            return {
                proxyUrl: null,
                source: 'windows',
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

        return noneDetection();
    } catch (error) {
        Logger.error('Windows registry query failed:', error);
        return noneDetection();
    }
}

export function parseWindowsProxyServer(proxyValue: string): WindowsProxyServerParse {
    if (!proxyValue.includes('=')) {
        const url = normalizeProxyEndpoint(proxyValue);
        return url ? { http: url, https: url } : {};
    }

    const parsed: WindowsProxyServerParse = {};
    for (const part of proxyValue.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const key = part.slice(0, separator).trim().toLowerCase();
        const url = normalizeProxyEndpoint(part.slice(separator + 1));
        if (!url) {
            continue;
        }
        if (key === 'http') {
            parsed.http = url;
        } else if (key === 'https') {
            parsed.https = url;
        }
    }
    return parsed;
}

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

export async function detectMacOSProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    const interfaces = await listMacOSNetworkServices(exec);
    let firstPacUrl: string | undefined;

    for (const iface of interfaces) {
        const http = await readMacNetworkProxy(exec, '-getwebproxy', iface);
        const https = await readMacNetworkProxy(exec, '-getsecurewebproxy', iface);
        if (http || https) {
            return buildDetectedProxyValue({
                http,
                https,
                source: 'macos'
            });
        }
        if (!firstPacUrl) {
            firstPacUrl = await readMacAutoProxyUrl(exec, iface);
        }
    }

    if (firstPacUrl) {
        return {
            proxyUrl: null,
            source: 'macos',
            kind: 'pac',
            capability: 'unsupported',
            issue: createUnsupportedAutoConfigIssue({
                id: 'macos.autoproxy.pac',
                targetId: 'macos.networksetup',
                targetHost: 'unavailable',
                source: 'networksetup',
                kind: 'pac',
                autoConfigUrl: firstPacUrl
            })
        };
    }

    return noneDetection();
}

async function readMacNetworkProxy(
    exec: CommandExecutor,
    flag: '-getwebproxy' | '-getsecurewebproxy',
    iface: string
): Promise<string | undefined> {
    try {
        const { stdout } = await exec('networksetup', [flag, iface]);
        const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
        const serverMatch = stdout.match(/Server:\s*(.+)/);
        const portMatch = stdout.match(/Port:\s*(\d+)/);

        if (enabledMatch && enabledMatch[1] === 'Yes' && serverMatch && portMatch) {
            return `http://${serverMatch[1].trim()}:${portMatch[1].trim()}`;
        }
    } catch (error) {
        Logger.debug(`Interface ${iface} ${flag} not available or failed:`, error);
    }
    return undefined;
}

async function readMacAutoProxyUrl(exec: CommandExecutor, iface: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec('networksetup', ['-getautoproxyurl', iface]);
        const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
        const urlMatch = stdout.match(/URL:\s*(.+)/);
        const url = urlMatch?.[1]?.trim();
        if (enabledMatch?.[1] === 'Yes' && url && url !== '(null)') {
            return url;
        }
    } catch (error) {
        Logger.debug(`Interface ${iface} -getautoproxyurl not available or failed:`, error);
    }
    return undefined;
}

export async function detectLinuxProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        const { stdout: mode } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);

        if (mode.includes('auto')) {
            let autoConfigUrl: string | undefined;
            try {
                const { stdout: rawUrl } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url']);
                const cleaned = rawUrl.replace(/'/g, '').trim();
                autoConfigUrl = cleaned || undefined;
            } catch {
                autoConfigUrl = undefined;
            }
            return {
                proxyUrl: null,
                source: 'linux',
                kind: 'pac',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'linux.gnome.auto',
                    targetId: 'linux.gsettings',
                    targetHost: 'unavailable',
                    source: 'gsettings',
                    kind: 'pac',
                    autoConfigUrl
                })
            };
        }

        if (!mode.includes('manual')) {
            return noneDetection();
        }

        const http = await readGnomeSchemeProxy(exec, 'http');
        const https = await readGnomeSchemeProxy(exec, 'https');
        return buildDetectedProxyValue({
            http,
            https,
            source: 'linux'
        });
    } catch (error) {
        Logger.error('Linux gsettings query failed (gsettings not available or not GNOME):', error);
        return noneDetection();
    }
}

async function readGnomeSchemeProxy(exec: CommandExecutor, scheme: 'http' | 'https'): Promise<string | undefined> {
    try {
        const { stdout: host } = await exec('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'host']);
        const { stdout: port } = await exec('gsettings', ['get', `org.gnome.system.proxy.${scheme}`, 'port']);
        const cleanHost = host.replace(/'/g, '').trim();
        const cleanPort = port.trim();
        return cleanHost && cleanPort !== '0' ? `http://${cleanHost}:${cleanPort}` : undefined;
    } catch (error) {
        Logger.debug(`GNOME ${scheme} proxy query failed:`, error);
        return undefined;
    }
}
