import * as assert from 'assert';
import { detectPlatformProxyWithSource } from '../config/PlatformProxyDetection';
import { PlatformMocker } from './crossPlatformMockers';

const HTTP_A = 'http://proxy-a.example.com:8080';
const HTTPS_B = 'http://proxy-b.example.com:8443';

suite('PlatformProxyDetection split #56', () => {
    let restorePlatform: (() => void) | null = null;

    teardown(() => {
        restorePlatform?.();
        restorePlatform = null;
    });

    test('macOS keeps -getwebproxy and -getsecurewebproxy distinct', async () => {
        restorePlatform = PlatformMocker.mockPlatform('darwin');
        const detected = await detectPlatformProxyWithSource(async (_command, args) => {
            if (args.includes('-getwebproxy')) {
                return { stdout: 'Enabled: Yes\nServer: proxy-a.example.com\nPort: 8080\n', stderr: '' };
            }
            if (args.includes('-getsecurewebproxy')) {
                return { stdout: 'Enabled: Yes\nServer: proxy-b.example.com\nPort: 8443\n', stderr: '' };
            }
            throw new Error(`unexpected ${args.join(' ')}`);
        });

        assert.strictEqual(detected.source, 'macos');
        assert.strictEqual(detected.kind, 'perSchemeProxy');
        assert.strictEqual(detected.httpUrl, HTTP_A);
        assert.strictEqual(detected.httpsUrl, HTTPS_B);
    });

    test('GNOME keeps HTTP and HTTPS hosts distinct', async () => {
        restorePlatform = PlatformMocker.mockPlatform('linux');
        const detected = await detectPlatformProxyWithSource(async (_command, args) => {
            if (args[0] === 'list-recursively' && args[1] === 'org.gnome.system.proxy') {
                return {
                    stdout: [
                        "org.gnome.system.proxy mode 'manual'",
                        "org.gnome.system.proxy.http host 'proxy-a.example.com'",
                        'org.gnome.system.proxy.http port 8080',
                        "org.gnome.system.proxy.https host 'proxy-b.example.com'",
                        'org.gnome.system.proxy.https port 8443'
                    ].join('\n') + '\n',
                    stderr: ''
                };
            }
            throw new Error(`unexpected ${args.join(' ')}`);
        });

        assert.strictEqual(detected.source, 'linux');
        assert.strictEqual(detected.kind, 'perSchemeProxy');
        assert.strictEqual(detected.httpUrl, HTTP_A);
        assert.strictEqual(detected.httpsUrl, HTTPS_B);
    });
});
