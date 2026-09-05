/**
 * Issue #53: IPv6 proxy URLs must be classified separately from DNS/IPv4.
 * DNS hostname regex must not gain `:`. CONNECT hostname is unbracketed.
 */

import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { ProxyUrlValidator } from '../../validation/ProxyUrlValidator';
import { DNS_HOSTNAME_PATTERN } from '../../validation/ProxyHost';
import { splitProxyUrl } from '../../security/ProxyCredentialStore';
import { getProxyPublicUrl } from '../../utils/ProxyStateSanitizer';
import { normalizeProxyForComparison } from '../../utils/ProxyUrlIdentity';
import { buildConnectRequestOptions, createProxyConnectRequest } from '../../utils/ProxyConnectRequest';
import { InputSanitizer } from '../../validation/InputSanitizer';
import { ProxySecretRedactor } from '../../security/ProxySecretRedactor';
import { testProxyConnection } from '../../utils/ProxyConnectionTest';

function listenOn(host: string): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.removeListener('error', reject);
            const address = server.address();
            if (typeof address === 'object' && address !== null) {
                resolve({ server, port: address.port });
                return;
            }
            reject(new Error('Unable to determine listen port'));
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

suite('Issue #53 IPv6 proxy authority', () => {
    const validator = new ProxyUrlValidator();
    const sanitizer = new InputSanitizer();
    const redactor = new ProxySecretRedactor();

    suite('DNS / IPv4 / IPv6 classification', () => {
        test('DNS hostname pattern still rejects colon', () => {
            assert.ok(DNS_HOSTNAME_PATTERN.test('proxy.example.com'));
            assert.ok(!DNS_HOSTNAME_PATTERN.test('proxy:example.com'));
            assert.ok(!DNS_HOSTNAME_PATTERN.test('::1'));
            assert.ok(!DNS_HOSTNAME_PATTERN.test('[::1]'));
        });

        test('accepts bracketed IPv6 loopback and documentation addresses', () => {
            for (const url of ['http://[::1]:8080', 'http://[2001:db8::1]:8080']) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, true, `${url} errors: ${result.errors.join(', ')}`);
                assert.strictEqual(result.errors.length, 0, url);
            }
        });

        test('accepts IPv4 and DNS without changing their existing rules', () => {
            assert.strictEqual(validator.validate('http://127.0.0.1:8080').isValid, true);
            assert.strictEqual(validator.validate('http://proxy.example.com:8080').isValid, true);
            assert.strictEqual(validator.validate('http://proxy-server.example.com').isValid, true);
        });

        test('rejects unbracketed IPv6 and fake bracketed DNS', () => {
            const unbracketed = validator.validate('http://::1:8080');
            assert.strictEqual(unbracketed.isValid, false);
            assert.ok(
                unbracketed.errors.some(error => error.toLowerCase().includes('bracket')),
                `expected bracket guidance: ${unbracketed.errors.join(', ')}`
            );

            const fake = validator.validate('http://[proxy.com]:8080');
            assert.strictEqual(fake.isValid, false);
            assert.ok(
                fake.errors.some(error =>
                    error.toLowerCase().includes('ipv6') || error.toLowerCase().includes('hostname')
                ),
                `expected IPv6/hostname error: ${fake.errors.join(', ')}`
            );
        });

        test('rejects IPv6-looking hosts that are not WHATWG bracketed authority', () => {
            assert.strictEqual(validator.validate('http://2001:db8::1').isValid, false);
            assert.strictEqual(validator.validate('http://[::1').isValid, false);
            assert.strictEqual(validator.validate('http://::1]').isValid, false);
        });
    });

    suite('split / public URL / identity', () => {
        test('splitProxyUrl stores unbracketed IPv6 host and public href', () => {
            const split = splitProxyUrl('http://user:secret@[::1]:8080');
            assert.strictEqual(split.publicRef.kind, 'singleProxy');
            assert.strictEqual(split.publicRef.host, '::1');
            assert.strictEqual(split.publicRef.port, 8080);
            assert.strictEqual(split.publicUrl, 'http://[::1]:8080/');
            assert.ok(!JSON.stringify(split.publicRef).includes('secret'));
        });

        test('getProxyPublicUrl strips credentials from IPv6 URLs', () => {
            assert.strictEqual(
                getProxyPublicUrl('http://user:secret@[2001:db8::1]:8080'),
                'http://[2001:db8::1]:8080/'
            );
        });

        test('[::1]:8080 and http://[::1]:8080/ share one public identity', () => {
            assert.strictEqual(
                normalizeProxyForComparison('[::1]:8080'),
                normalizeProxyForComparison('http://[::1]:8080/')
            );
            assert.strictEqual(normalizeProxyForComparison('[::1]:8080'), 'http://[::1]:8080/');
        });

        test('identity comparison does not treat DNS scheme-less values as IPv6', () => {
            assert.strictEqual(
                normalizeProxyForComparison('proxy.example.com:8080'),
                'proxy.example.com:8080'
            );
        });
    });

    suite('redaction', () => {
        test('InputSanitizer masks IPv6 passwords and never echoes the secret', () => {
            const secret = 's3cret-ipv6';
            const masked = sanitizer.maskPassword(`http://user:${secret}@[::1]:8080`);
            assert.ok(!masked.includes(secret), masked);
            assert.ok(masked.includes('user:****@'), masked);
            assert.ok(masked.includes('[::1]:8080'), masked);
        });

        test('ProxySecretRedactor uses public IPv6 host and drops credentials', () => {
            const secret = 's3cret-ipv6';
            const redacted = redactor.redactString(`http://user:${secret}@[::1]:8080`);
            assert.ok(!redacted.includes(secret), redacted);
            assert.strictEqual(redacted, 'http://<credentials>@[::1]:8080');
        });
    });

    suite('CONNECT hostname', () => {
        test('buildConnectRequestOptions uses unbracketed IPv6 hostname and explicit port', () => {
            const options = buildConnectRequestOptions(
                new URL('http://[::1]:8080'),
                new URL('https://example.com:443'),
                1000
            );

            assert.strictEqual(options.hostname, '::1');
            assert.strictEqual(options.port, 8080);
            assert.strictEqual(options.method, 'CONNECT');
            assert.strictEqual(options.path, 'example.com:443');
        });

        test('CONNECT path keeps WHATWG target hostname (brackets stay on IPv6 targets)', () => {
            const options = buildConnectRequestOptions(
                new URL('http://[2001:db8::1]:8080'),
                new URL('https://[2001:db8::2]:8443'),
                1000
            );

            assert.strictEqual(options.hostname, '2001:db8::1');
            assert.strictEqual(options.port, 8080);
            assert.strictEqual(options.path, `${new URL('https://[2001:db8::2]:8443').hostname}:8443`);
        });

        test('hermetic CONNECT to a local ::1 proxy succeeds', async function() {
            this.timeout(5000);

            let capturedHost: string | undefined;
            let capturedUrl: string | undefined;
            let server: http.Server;
            let port: number;
            try {
                const listening = await listenOn('::1');
                server = listening.server;
                port = listening.port;
            } catch (error) {
                this.skip();
                return;
            }

            server.on('connect', (request, socket) => {
                capturedHost = request.headers.host;
                capturedUrl = request.url;
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                socket.destroy();
            });

            try {
                const proxyUrl = `http://[::1]:${port}`;
                assert.strictEqual(validator.validate(proxyUrl).isValid, true, proxyUrl);

                const result = await testProxyConnection(proxyUrl, {
                    timeout: 1000,
                    testUrls: ['https://example.com:443']
                });

                assert.strictEqual(result.success, true, JSON.stringify(result.errors));
                assert.ok(!JSON.stringify(result).includes('s3cret'));
                assert.strictEqual(capturedUrl, 'example.com:443');
                assert.ok(typeof capturedHost === 'string' || capturedHost === undefined);
                assert.strictEqual(net.isIPv6('::1'), true);
            } finally {
                await close(server);
            }
        });

        test('http.request CONNECT hostname is the unbracketed IPv6 literal', async function() {
            this.timeout(5000);

            let server: http.Server;
            let port: number;
            try {
                const listening = await listenOn('::1');
                server = listening.server;
                port = listening.port;
            } catch {
                this.skip();
                return;
            }

            server.on('connect', (_request, socket) => {
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                socket.destroy();
            });

            try {
                const options = buildConnectRequestOptions(
                    new URL(`http://[::1]:${port}`),
                    new URL('https://example.com:443'),
                    1000
                );
                assert.strictEqual(options.hostname, '::1');

                await new Promise<void>((resolve, reject) => {
                    const req = createProxyConnectRequest(new URL(`http://[::1]:${port}`), options);
                    req.on('connect', (_response, socket) => {
                        socket.destroy();
                        req.destroy();
                        resolve();
                    });
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('CONNECT timeout'));
                    });
                    req.end();
                });
            } finally {
                await close(server);
            }
        });
    });
});
