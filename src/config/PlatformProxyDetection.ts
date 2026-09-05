import { Logger } from '../utils/Logger';
import { buildDetectedProxyValue, normalizeProxyEndpoint } from './DetectedProxyValue';
import type { ProxyDetectionWithSource } from './SystemProxyDetector';

export type CommandExecutor = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsProxyServerParse {
    http?: string;
    https?: string;
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

async function detectWindowsProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        // Query the whole key once: it returns both ProxyEnable and ProxyServer,
        // so this halves the child processes spawned on every detection cycle
        // (the only recurring process spawn in the polling loop).
        const { stdout } = await exec('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY]);

        const enableMatch = stdout.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);
        if (!enableMatch || enableMatch[1] !== '1') {
            return { proxyUrl: null, source: null };
        }

        const match = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        const parsed = match?.[1] ? parseWindowsProxyServer(match[1].trim()) : {};
        const overrideMatch = stdout.match(/ProxyOverride\s+REG_SZ\s+(.+)/);

        return buildDetectedProxyValue({
            http: parsed.http,
            https: parsed.https,
            bypass: overrideMatch?.[1]?.trim(),
            source: 'windows'
        });
    } catch (error) {
        Logger.error('Windows registry query failed:', error);
        return { proxyUrl: null, source: null };
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

async function detectMacOSProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    const interfaces = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

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
    }

    return { proxyUrl: null, source: null };
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

async function detectLinuxProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        const { stdout: mode } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);

        if (!mode.includes('manual')) {
            return { proxyUrl: null, source: null };
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
        return { proxyUrl: null, source: null };
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
