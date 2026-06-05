import { Logger } from '../utils/Logger';
import type { ProxyDetectionWithSource } from './SystemProxyDetector';

export type CommandExecutor = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export async function detectPlatformProxyWithSource(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        switch (process.platform) {
            case 'win32': {
                const proxy = await detectWindowsProxy(exec);
                return { proxyUrl: proxy, source: proxy ? 'windows' : null };
            }
            case 'darwin': {
                const proxy = await detectMacOSProxy(exec);
                return { proxyUrl: proxy, source: proxy ? 'macos' : null };
            }
            case 'linux': {
                const proxy = await detectLinuxProxy(exec);
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

async function detectWindowsProxy(exec: CommandExecutor): Promise<string | null> {
    try {
        const { stdout: enabledOutput } = await exec('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            'ProxyEnable'
        ]);
        const enableMatch = enabledOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);

        if (!enableMatch || enableMatch[1] !== '1') {
            return null;
        }

        const { stdout } = await exec('reg', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            'ProxyServer'
        ]);
        const match = stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);

        return match?.[1] ? parseWindowsProxyValue(match[1].trim()) : null;
    } catch (error) {
        Logger.error('Windows registry query failed:', error);
        return null;
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

async function detectMacOSProxy(exec: CommandExecutor): Promise<string | null> {
    const interfaces = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

    for (const iface of interfaces) {
        try {
            const { stdout } = await exec('networksetup', ['-getwebproxy', iface]);
            const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
            const serverMatch = stdout.match(/Server:\s*(.+)/);
            const portMatch = stdout.match(/Port:\s*(\d+)/);

            if (enabledMatch && enabledMatch[1] === 'Yes' && serverMatch && portMatch) {
                const server = serverMatch[1].trim();
                const port = portMatch[1].trim();
                return `http://${server}:${port}`;
            }
        } catch (error) {
            Logger.debug(`Interface ${iface} not available or failed:`, error);
        }
    }

    return null;
}

async function detectLinuxProxy(exec: CommandExecutor): Promise<string | null> {
    try {
        const { stdout: mode } = await exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);

        if (!mode.includes('manual')) {
            return null;
        }

        const { stdout: host } = await exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'host']);
        const { stdout: port } = await exec('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']);
        const cleanHost = host.replace(/'/g, '').trim();
        const cleanPort = port.trim();

        return cleanHost && cleanPort !== '0'
            ? `http://${cleanHost}:${cleanPort}`
            : null;
    } catch (error) {
        Logger.error('Linux gsettings query failed (gsettings not available or not GNOME):', error);
        return null;
    }
}
