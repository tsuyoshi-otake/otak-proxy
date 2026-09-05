import * as assert from 'assert';
import {
    detectLinuxProxy,
    detectMacOSProxy,
    detectWindowsProxy,
    parseMacOSNetworkServices
} from '../config/PlatformProxyDetection';
import type { CommandExecutor } from '../config/PlatformProxyDetection';

function windowsInternetSettings(values: Record<string, string>): string {
    const lines = Object.entries(values).map(([name, rest]) => `    ${name}    ${rest}`);
    return `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${lines.join('\r\n')}\r\n`;
}

function macWebProxy(enabled: boolean, server = 'proxy.example.com', port = '8080'): string {
    return `Enabled: ${enabled ? 'Yes' : 'No'}\nServer: ${enabled ? server : ''}\nPort: ${enabled ? port : '0'}\nAuthenticated Proxy Enabled: 0\n`;
}

function macAutoProxy(enabled: boolean, url = 'http://pac.example.com/proxy.pac'): string {
    return `URL: ${enabled ? url : ''}\nEnabled: ${enabled ? 'Yes' : 'No'}\n`;
}

suite('PlatformProxyDetection Auto-config (#58)', () => {
    suite('detectWindowsProxy', () => {
        test('ProxyEnable=0 + AutoConfigURL is unsupported PAC, not none', async () => {
            const exec: CommandExecutor = async (command, args) => {
                assert.strictEqual(command, 'reg');
                assert.ok(args.some(arg => arg.includes('Internet Settings')));
                return {
                    stdout: windowsInternetSettings({
                        ProxyEnable: 'REG_DWORD    0x0',
                        AutoConfigURL: 'REG_SZ    http://pac.example.com/proxy.pac'
                    }),
                    stderr: ''
                };
            };

            const result = await detectWindowsProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'pac');
            assert.strictEqual(result.capability, 'unsupported');
            assert.ok(result.issue);
            assert.strictEqual(result.issue?.id, 'windows.wininet.pac');
            assert.strictEqual(result.issue?.category, 'capabilityUnavailable');
            assert.strictEqual(result.issue?.capability, 'unsupported');
            assert.strictEqual(result.issue?.evidence.kind, 'pac');
            assert.strictEqual(result.issue?.evidence.autoConfigUrl, 'http://pac.example.com/proxy.pac');
        });

        test('redacts credentials in a PAC URL before they reach the issue', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({
                    ProxyEnable: 'REG_DWORD    0x0',
                    AutoConfigURL: 'REG_SZ    http://user:secret@pac.example.com/proxy.pac'
                }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);
            assert.strictEqual(result.kind, 'pac');
            const serialized = JSON.stringify(result.issue);
            assert.ok(!serialized.includes('secret'));
            assert.ok(!serialized.includes('user:secret'));
            assert.strictEqual(result.issue?.evidence.autoConfigUrl, 'http://<credentials>@pac.example.com/proxy.pac');
        });

        test('ProxyEnable=1 + ProxyServer still returns a usable URL', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({
                    ProxyEnable: 'REG_DWORD    0x1',
                    ProxyServer: 'REG_SZ    proxy.example.com:8080',
                    AutoConfigURL: 'REG_SZ    http://pac.example.com/proxy.pac'
                }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);
            assert.strictEqual(result.proxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(result.kind, 'singleProxy');
            assert.strictEqual(result.capability, 'supported');
            assert.strictEqual(result.issue, undefined);
        });

        test('ProxyEnable=0 without AutoConfigURL or AutoDetect is none', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({
                    ProxyEnable: 'REG_DWORD    0x0'
                }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'direct');
            assert.notStrictEqual(result.capability, 'unsupported');
            assert.strictEqual(result.issue, undefined);
        });

        test('AutoDetect=1 without AutoConfigURL is observed as unsupported WPAD (registry bit only)', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({
                    ProxyEnable: 'REG_DWORD    0x0',
                    AutoDetect: 'REG_DWORD    0x1'
                }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'wpad');
            assert.strictEqual(result.capability, 'unsupported');
            assert.strictEqual(result.issue?.id, 'windows.wininet.wpad');
            assert.strictEqual(result.issue?.evidence.kind, 'wpad');
            assert.strictEqual(result.issue?.evidence.observation, 'registry AutoDetect');
        });
    });

    suite('detectLinuxProxy', () => {
        test('mode=none is none', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('mode')) {
                    return { stdout: `'none'`, stderr: '' };
                }
                throw new Error(`unexpected gsettings args: ${args.join(' ')}`);
            };

            const result = await detectLinuxProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'direct');
            assert.notStrictEqual(result.capability, 'unsupported');
        });

        test('mode=manual with host/port returns a URL', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('mode')) {
                    return { stdout: `'manual'`, stderr: '' };
                }
                if (args.includes('host')) {
                    return { stdout: `'proxy.example.com'`, stderr: '' };
                }
                if (args.includes('port')) {
                    return { stdout: '8080', stderr: '' };
                }
                throw new Error(`unexpected gsettings args: ${args.join(' ')}`);
            };

            const result = await detectLinuxProxy(exec);
            assert.strictEqual(result.proxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(result.kind, 'singleProxy');
            assert.strictEqual(result.capability, 'supported');
        });

        test('mode=auto is unsupported PAC, not none', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('mode')) {
                    return { stdout: `'auto'`, stderr: '' };
                }
                if (args.includes('autoconfig-url')) {
                    return { stdout: `'http://pac.example.com/proxy.pac'`, stderr: '' };
                }
                throw new Error(`unexpected gsettings args: ${args.join(' ')}`);
            };

            const result = await detectLinuxProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'pac');
            assert.strictEqual(result.capability, 'unsupported');
            assert.strictEqual(result.issue?.id, 'linux.gnome.auto');
            assert.strictEqual(result.issue?.category, 'capabilityUnavailable');
            assert.strictEqual(result.issue?.evidence.kind, 'pac');
            assert.strictEqual(result.issue?.evidence.autoConfigUrl, 'http://pac.example.com/proxy.pac');
        });
    });

    suite('detectMacOSProxy', () => {
        test('enumerates listallnetworkservices and finds a renamed / USB service the hardcoded three would miss', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('-listallnetworkservices')) {
                    return {
                        stdout: 'An asterisk (*) denotes that a network service is disabled.\nUSB 10/100/1000 LAN\n*Thunderbolt Bridge\n',
                        stderr: ''
                    };
                }
                if (args.includes('-getwebproxy') && args.includes('USB 10/100/1000 LAN')) {
                    return { stdout: macWebProxy(true), stderr: '' };
                }
                if (args.includes('Wi-Fi') || args.includes('Ethernet') || args.includes('Thunderbolt Ethernet')) {
                    throw new Error('hardcoded service should not be queried when enumeration succeeds');
                }
                return { stdout: macWebProxy(false), stderr: '' };
            };

            const result = await detectMacOSProxy(exec);
            assert.strictEqual(result.proxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(result.kind, 'singleProxy');
            assert.strictEqual(result.capability, 'supported');
        });

        test('service-name miss with only the hardcoded three names would be none; enumeration finds USB Ethernet', async () => {
            const listed = parseMacOSNetworkServices(
                'An asterisk (*) denotes that a network service is disabled.\nUSB Ethernet\n'
            );
            assert.deepStrictEqual(listed, ['USB Ethernet']);
            assert.ok(!listed.includes('Wi-Fi'));
            assert.ok(!listed.includes('Ethernet'));
            assert.ok(!listed.includes('Thunderbolt Ethernet'));
        });

        test('enabled auto-proxy URL on an enumerated service is unsupported PAC, not none', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('-listallnetworkservices')) {
                    return {
                        stdout: 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n',
                        stderr: ''
                    };
                }
                if (args.includes('-getwebproxy') || args.includes('-getsecurewebproxy')) {
                    return { stdout: macWebProxy(false), stderr: '' };
                }
                if (args.includes('-getautoproxyurl')) {
                    return { stdout: macAutoProxy(true, 'http://pac.example.com/proxy.pac'), stderr: '' };
                }
                throw new Error(`unexpected networksetup args: ${args.join(' ')}`);
            };

            const result = await detectMacOSProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'pac');
            assert.strictEqual(result.capability, 'unsupported');
            assert.strictEqual(result.issue?.id, 'macos.autoproxy.pac');
            assert.strictEqual(result.issue?.evidence.kind, 'pac');
        });

        test('skips disabled services marked with *', async () => {
            const services = parseMacOSNetworkServices(
                'An asterisk (*) denotes that a network service is disabled.\n*Wi-Fi\nEthernet\n'
            );
            assert.deepStrictEqual(services, ['Ethernet']);
        });

        test('falls back to the three well-known names when listallnetworkservices fails', async () => {
            const queried: string[] = [];
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('-listallnetworkservices')) {
                    throw new Error('networksetup list failed');
                }
                queried.push(String(args[args.length - 1]));
                return { stdout: macWebProxy(false), stderr: '' };
            };

            const result = await detectMacOSProxy(exec);
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.kind, 'direct');
            assert.ok(queried.includes('Wi-Fi'));
            assert.ok(queried.includes('Ethernet'));
            assert.ok(queried.includes('Thunderbolt Ethernet'));
        });
    });
});
