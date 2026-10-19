import * as assert from 'assert';
import {
    detectLinuxProxy,
    detectMacOSProxy,
    detectPlatformProxyWithSource,
    detectWindowsProxy,
    parseWindowsProxyServer
} from '../config/PlatformProxyDetection';
import type { CommandExecutor } from '../config/PlatformProxyDetection';
import { WindowsProxyDiagnostics } from '../diagnostics/WindowsProxyDiagnostics';
import { PlatformMocker } from './crossPlatformMockers';

function windowsInternetSettings(values: Record<string, string>): string {
    const lines = Object.entries(values).map(([name, rest]) => `    ${name}    ${rest}`);
    return `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n${lines.join('\r\n')}\r\n`;
}

function commandError(message: string, extra: { code?: string; stderr?: string } = {}): Error {
    return Object.assign(new Error(message), extra);
}

const ENGLISH_NO_SCHEMA = 'No such schema \u201Corg.gnome.system.proxy\u201D\n';
const TRANSLATED_NO_SCHEMA = 'Schema \u201Eorg.gnome.system.proxy\u201C gibt es nicht\n';

suite('Failed platform query is not "no proxy" (#108)', () => {
    let restorePlatform: (() => void) | null = null;

    teardown(() => {
        restorePlatform?.();
        restorePlatform = null;
    });

    suite('Windows', () => {
        test('a rejected reg query is unknown, not direct', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: reg query', { stderr: 'ERROR: Access is denied.' });
            };

            const result = await detectWindowsProxy(exec);

            assert.deepStrictEqual(result, { proxyUrl: null, source: null, kind: 'unknown' });
        });

        test('a missing Internet Settings key is direct, not unknown', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: reg query', {
                    stderr: 'ERROR: The system was unable to find the specified registry key or value.\r\n'
                });
            };

            const result = await detectWindowsProxy(exec);

            assert.strictEqual(result.kind, 'direct');
            assert.strictEqual(result.proxyUrl, null);
        });

        test('a timed-out reg query is unknown', async () => {
            const exec: CommandExecutor = async () => {
                throw Object.assign(new Error('spawn reg ETIMEDOUT'), { killed: true, signal: 'SIGTERM' });
            };

            assert.strictEqual((await detectWindowsProxy(exec)).kind, 'unknown');
        });

        test('a registry key with no proxy configured is still direct', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({ ProxyEnable: 'REG_DWORD    0x0' }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);

            assert.strictEqual(result.kind, 'direct');
            assert.strictEqual(result.proxyUrl, null);
        });

        test('an unexpected error in the dispatcher is unknown', async () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');
            const exec: CommandExecutor = async () => {
                throw new Error('boom');
            };

            assert.strictEqual((await detectPlatformProxyWithSource(exec)).kind, 'unknown');
        });
    });

    suite('Linux', () => {
        const manualMode = (overrides: Record<string, () => string>): CommandExecutor => async (_command, args) => {
            const key = `${args[1]}:${args[2]}`;
            if (key === 'org.gnome.system.proxy:mode') {
                return { stdout: "'manual'\n", stderr: '' };
            }
            const answer = overrides[key];
            if (!answer) {
                throw new Error(`unexpected gsettings args: ${args.join(' ')}`);
            }
            return { stdout: answer(), stderr: '' };
        };
        const failing = (): string => {
            throw commandError('Command failed: gsettings get', { stderr: 'dconf-CRITICAL: unable to open' });
        };

        test('a failing mode read is unknown', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: gsettings', { stderr: 'dconf-CRITICAL: unable to open' });
            };

            assert.deepStrictEqual(await detectLinuxProxy(exec), { proxyUrl: null, source: null, kind: 'unknown' });
        });

        test('gsettings missing (ENOENT) is not applicable: none', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('spawn gsettings ENOENT', { code: 'ENOENT' });
            };

            const result = await detectLinuxProxy(exec);

            assert.strictEqual(result.kind, 'direct');
            assert.strictEqual(result.proxyUrl, null);
        });

        test('no GNOME proxy schema is not applicable: none', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: gsettings get org.gnome.system.proxy mode', {
                    stderr: ENGLISH_NO_SCHEMA
                });
            };

            assert.strictEqual((await detectLinuxProxy(exec)).kind, 'direct');
        });

        test('an empty schema registry ("No schemas installed") is not applicable: none', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: gsettings get org.gnome.system.proxy mode', {
                    stderr: 'No schemas installed\n'
                });
            };

            assert.strictEqual((await detectLinuxProxy(exec)).kind, 'direct');
        });

        test('a translated "no such schema" message is still none because every call asks for the C locale', async () => {
            const seenEnvironments: Array<Record<string, string> | undefined> = [];
            const exec: CommandExecutor = async (_command, _args, options) => {
                seenEnvironments.push(options?.env);
                const untranslated = options?.env?.LANGUAGE === 'C';
                throw commandError('Command failed: gsettings', {
                    stderr: untranslated ? ENGLISH_NO_SCHEMA : TRANSLATED_NO_SCHEMA
                });
            };

            const result = await detectLinuxProxy(exec);

            assert.strictEqual(result.kind, 'direct', 'fails before: unknown on a non-English desktop');
            assert.ok(seenEnvironments.length > 0);
        });

        test('every gsettings call carries LANGUAGE=C and LC_MESSAGES=C and nothing else', async () => {
            const environments: Array<Record<string, string> | undefined> = [];
            const exec: CommandExecutor = async (command, args, options) => {
                assert.strictEqual(command, 'gsettings');
                environments.push(options?.env);
                const key = `${args[1]}:${args[2]}`;
                const answers: Record<string, string> = {
                    'org.gnome.system.proxy:mode': "'manual'\n",
                    'org.gnome.system.proxy.http:host': "'proxy.example.com'\n",
                    'org.gnome.system.proxy.http:port': '8080\n',
                    'org.gnome.system.proxy.https:host': "''\n",
                    'org.gnome.system.proxy.https:port': '0\n'
                };
                return { stdout: answers[key] ?? '', stderr: '' };
            };

            const result = await detectLinuxProxy(exec);

            assert.strictEqual(result.proxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(environments.length, 5);
            for (const env of environments) {
                assert.deepStrictEqual(env, { LANGUAGE: 'C', LC_MESSAGES: 'C' });
            }
        });

        test('the auto-config URL read also asks for the C locale', async () => {
            const environments: Array<Record<string, string> | undefined> = [];
            const exec: CommandExecutor = async (_command, args, options) => {
                environments.push(options?.env);
                return { stdout: args[2] === 'mode' ? "'auto'\n" : "'http://pac.example.com/proxy.pac'\n", stderr: '' };
            };

            const result = await detectLinuxProxy(exec);

            assert.strictEqual(result.kind, 'pac');
            assert.strictEqual(environments.length, 2);
            assert.ok(environments.every(env => env?.LANGUAGE === 'C' && env.LC_MESSAGES === 'C'));
        });

        test('manual mode with both scheme reads failing is unknown', async () => {
            const exec = manualMode({
                'org.gnome.system.proxy.http:host': failing,
                'org.gnome.system.proxy.https:host': failing
            });

            assert.strictEqual((await detectLinuxProxy(exec)).kind, 'unknown');
        });

        test('manual mode with one scheme failing and the other empty is unknown', async () => {
            const exec = manualMode({
                'org.gnome.system.proxy.http:host': failing,
                'org.gnome.system.proxy.https:host': () => "''\n",
                'org.gnome.system.proxy.https:port': () => '0\n'
            });

            assert.strictEqual((await detectLinuxProxy(exec)).kind, 'unknown');
        });

        test('manual mode with one scheme failing and the other giving a proxy returns the proxy', async () => {
            const exec = manualMode({
                'org.gnome.system.proxy.http:host': failing,
                'org.gnome.system.proxy.https:host': () => "'tls.example.com'\n",
                'org.gnome.system.proxy.https:port': () => '8443\n'
            });

            const result = await detectLinuxProxy(exec);

            assert.strictEqual(result.kind, 'singleProxy');
            assert.strictEqual(result.proxyUrl, 'http://tls.example.com:8443');
        });

        test('manual mode with both schemes empty is none', async () => {
            const exec = manualMode({
                'org.gnome.system.proxy.http:host': () => "''\n",
                'org.gnome.system.proxy.http:port': () => '0\n',
                'org.gnome.system.proxy.https:host': () => "''\n",
                'org.gnome.system.proxy.https:port': () => '0\n'
            });

            assert.strictEqual((await detectLinuxProxy(exec)).kind, 'direct');
        });
    });

    suite('macOS', () => {
        test('the list and every per-service query failing is unknown', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: networksetup');
            };

            assert.deepStrictEqual(await detectMacOSProxy(exec), { proxyUrl: null, source: null, kind: 'unknown' });
        });

        test('a list that succeeds with no enabled service is direct and guesses no service names', async () => {
            const queried: string[] = [];
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('-listallnetworkservices')) {
                    return {
                        stdout: 'An asterisk (*) denotes that a network service is disabled.\n*Wi-Fi\n',
                        stderr: ''
                    };
                }
                queried.push(args.join(' '));
                throw commandError('Command failed: networksetup');
            };

            const result = await detectMacOSProxy(exec);

            assert.strictEqual(result.kind, 'direct');
            assert.deepStrictEqual(queried, [], 'no fallback service is queried');
        });

        test('a failing list with answering fallback services is none', async () => {
            const exec: CommandExecutor = async (_command, args) => {
                if (args.includes('-listallnetworkservices')) {
                    throw commandError('Command failed: networksetup');
                }
                return { stdout: 'Enabled: No\nServer: \nPort: 0\n', stderr: '' };
            };

            assert.strictEqual((await detectMacOSProxy(exec)).kind, 'direct');
        });
    });

    suite('Windows ProxyServer parsing', () => {
        const table: Array<{ label: string; value: string; http?: string; https?: string }> = [
            { label: 'a trailing semicolon', value: 'host:8080;', http: 'http://host:8080', https: 'http://host:8080' },
            { label: 'a space before the semicolon', value: 'host:8080 ;', http: 'http://host:8080', https: 'http://host:8080' },
            { label: 'a lone endpoint', value: 'host:8080', http: 'http://host:8080', https: 'http://host:8080' },
            { label: 'space-separated schemes', value: 'http=a:80 https=b:80', http: 'http://a:80', https: 'http://b:80' },
            { label: 'semicolon-separated schemes with a trailing semicolon', value: 'http=a:80;https=b:80;', http: 'http://a:80', https: 'http://b:80' },
            { label: 'one scheme alone', value: 'http=a:80', http: 'http://a:80' },
            { label: 'an empty part between separators', value: 'http=a:80;;https=b:80', http: 'http://a:80', https: 'http://b:80' },
            { label: 'semicolon-separated bare endpoints', value: 'a:80;b:80', http: 'http://a:80', https: 'http://a:80' },
            { label: 'only separators', value: ' ; ' }
        ];

        for (const row of table) {
            test(`parses ${row.label}: ${JSON.stringify(row.value)}`, () => {
                const parsed = parseWindowsProxyServer(row.value);

                assert.strictEqual(parsed.http, row.http);
                assert.strictEqual(parsed.https, row.https);
            });
        }

        test('a ProxyServer with a trailing semicolon is detected end to end, not dropped', async () => {
            const exec: CommandExecutor = async () => ({
                stdout: windowsInternetSettings({
                    ProxyEnable: 'REG_DWORD    0x1',
                    ProxyServer: 'REG_SZ    host.example.com:8080;'
                }),
                stderr: ''
            });

            const result = await detectWindowsProxy(exec);

            assert.strictEqual(result.proxyUrl, 'http://host.example.com:8080');
            assert.strictEqual(result.source, 'windows');
        });
    });

    suite('REG_DWORD flags', () => {
        const table: Array<{ value: string; enabled: boolean }> = [
            { value: '0x0', enabled: false },
            { value: '0x1', enabled: true },
            { value: '0x3', enabled: true },
            { value: '0x11', enabled: true },
            { value: '1', enabled: true },
            { value: '0', enabled: false },
            { value: 'garbage', enabled: false }
        ];

        for (const row of table) {
            test(`ProxyEnable ${row.value} is ${row.enabled ? 'enabled' : 'disabled'} in detection and in diagnostics`, async () => {
                const exec: CommandExecutor = async () => ({
                    stdout: windowsInternetSettings({
                        ProxyEnable: `REG_DWORD    ${row.value}`,
                        ProxyServer: 'REG_SZ    host.example.com:8080'
                    }),
                    stderr: ''
                });
                const detected = await detectWindowsProxy(exec);

                const diagnostics = new WindowsProxyDiagnostics(async (_command, args) => {
                    const name = args[args.indexOf('/v') + 1];
                    const values: Record<string, string> = {
                        ProxyEnable: `    ProxyEnable    REG_DWORD    ${row.value}\r\n`,
                        AutoDetect: `    AutoDetect    REG_DWORD    ${row.value}\r\n`
                    };
                    return { stdout: values[name] ?? '', stderr: '' };
                }, 'win32');
                const observed = await diagnostics.observe();

                assert.strictEqual(detected.proxyUrl !== null, row.enabled, 'detection');
                assert.strictEqual(observed.winInetProxyEnable, row.enabled, 'diagnostics ProxyEnable');
                assert.strictEqual(observed.winInetAutoDetect, row.enabled, 'diagnostics AutoDetect');
            });
        }
    });
});
