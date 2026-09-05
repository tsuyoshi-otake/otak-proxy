/**
 * @file utils/ProxyConnectRequest.ts Unit Tests
 * @description WHATWG default-port restoration for CONNECT request options.
 * Validates Issue #54: http://proxy:80 must not become 8080, http targets must not become 443.
 */

import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import {
    buildConnectRequestOptions,
    createProxyConnectRequest,
    formatConnectDestination
} from '../../utils/ProxyConnectRequest';
import { stripIpv6Brackets } from '../../validation/ProxyHost';

interface ConnectCase {
    name: string;
    proxy: string;
    target: string;
    expectedWhatwgProxyPort: string;
    expectedRequestPort: number;
    expectedConnectPath: string;
}

const CONNECT_CASES: ConnectCase[] = [
    {
        name: 'http proxy :80 + https target',
        proxy: 'http://proxy.example:80',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '',
        expectedRequestPort: 80,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'http proxy :8080 + https target',
        proxy: 'http://proxy.example:8080',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'https proxy :443 + https target',
        proxy: 'https://proxy.example:443',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '',
        expectedRequestPort: 443,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'http proxy :8080 + http target',
        proxy: 'http://proxy.example:8080',
        target: 'http://example.com',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: 'example.com:80'
    },
    {
        name: 'http proxy :8080 + http target :8081',
        proxy: 'http://proxy.example:8080',
        target: 'http://example.com:8081',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: 'example.com:8081'
    },
    {
        name: 'http proxy :8080 + https target :8443',
        proxy: 'http://proxy.example:8080',
        target: 'https://example.com:8443',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: 'example.com:8443'
    },
    {
        name: 'http proxy omitted port + https target',
        proxy: 'http://proxy.example',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '',
        expectedRequestPort: 80,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'IPv6 http proxy :80 + https target',
        proxy: 'http://[2001:db8::1]:80',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '',
        expectedRequestPort: 80,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'IPv6 http proxy :8080 + http target',
        proxy: 'http://[2001:db8::1]:8080',
        target: 'http://example.com',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: 'example.com:80'
    },
    {
        name: 'IPv6 https proxy :443 + https target',
        proxy: 'https://[2001:db8::1]:443',
        target: 'https://example.com',
        expectedWhatwgProxyPort: '',
        expectedRequestPort: 443,
        expectedConnectPath: 'example.com:443'
    },
    {
        name: 'http proxy + IPv6 http target',
        proxy: 'http://proxy.example:8080',
        target: 'http://[2001:db8::1]/',
        expectedWhatwgProxyPort: '8080',
        expectedRequestPort: 8080,
        expectedConnectPath: '[2001:db8::1]:80'
    }
];

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            const address = server.address();
            if (typeof address === 'object' && address !== null) {
                resolve(address.port);
                return;
            }
            reject(new Error('Unable to determine test proxy port'));
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

suite('ProxyConnectRequest default ports', () => {
    for (const connectCase of CONNECT_CASES) {
        test(connectCase.name, () => {
            const proxy = new URL(connectCase.proxy);
            const target = new URL(connectCase.target);

            assert.strictEqual(
                proxy.port,
                connectCase.expectedWhatwgProxyPort,
                `WHATWG proxy.port for ${connectCase.proxy}`
            );

            const options = buildConnectRequestOptions(proxy, target, 1000);

            assert.strictEqual(options.port, connectCase.expectedRequestPort, 'request.port');
            assert.strictEqual(options.path, connectCase.expectedConnectPath, 'CONNECT path');
            assert.strictEqual(options.method, 'CONNECT');
            assert.strictEqual(options.hostname, stripIpv6Brackets(proxy.hostname));
        });
    }

    test('explicit custom ports win over scheme defaults', () => {
        const options = buildConnectRequestOptions(
            new URL('http://proxy.example:8080'),
            new URL('https://example.com:8443'),
            1000
        );

        assert.strictEqual(options.port, 8080);
        assert.strictEqual(options.path, 'example.com:8443');
    });

    test('formatConnectDestination never includes credentials or authorization', () => {
        const secretUser = 'alice';
        const secretPassword = 's3cret-value';
        const options = buildConnectRequestOptions(
            new URL(`http://${secretUser}:${secretPassword}@proxy.example:8080`),
            new URL('https://example.com'),
            1000
        );

        const destination = formatConnectDestination(options);
        assert.ok(destination.includes('proxy.example:8080'), destination);
        assert.ok(destination.includes('CONNECT example.com:443'), destination);
        assert.ok(!destination.includes(secretUser), destination);
        assert.ok(!destination.includes(secretPassword), destination);
        assert.ok(!destination.toLowerCase().includes('authorization'), destination);
        assert.ok(!destination.includes('Basic '), destination);
        const authorization = options.headers?.['Proxy-Authorization'];
        assert.ok(typeof authorization === 'string' && authorization.startsWith('Basic '));
    });
});

suite('ProxyConnectRequest hermetic CONNECT', () => {
    test('WHATWG http://127.0.0.1:80 attempts port 80, not 8080', async function() {
        this.timeout(5000);

        const proxy = new URL('http://127.0.0.1:80');
        assert.strictEqual(proxy.port, '', 'WHATWG must empty default http port 80');

        const options = buildConnectRequestOptions(proxy, new URL('https://example.com'), 500);
        assert.strictEqual(options.port, 80);

        const attemptedPort = await new Promise<number>((resolve, reject) => {
            const req = createProxyConnectRequest(proxy, options);
            req.on('error', (error: NodeJS.ErrnoException & { port?: number }) => {
                if (typeof error.port === 'number') {
                    resolve(error.port);
                    return;
                }
                const match = /ECONNREFUSED\s+\S+:(\d+)/.exec(error.message);
                if (match) {
                    resolve(Number(match[1]));
                    return;
                }
                reject(error);
            });
            req.on('connect', (_response, socket) => {
                socket.destroy();
                req.destroy();
                resolve(Number(options.port));
            });
            req.on('timeout', () => {
                req.destroy();
                resolve(Number(options.port));
            });
            req.end();
        });

        assert.strictEqual(attemptedPort, 80, 'socket attempt must target 80, not 8080');
    });

    test('local proxy receives scheme-default CONNECT paths for http and https targets', async function() {
        this.timeout(5000);

        const capturedPaths: string[] = [];
        const server = http.createServer();
        server.on('connect', (request, socket) => {
            capturedPaths.push(request.url ?? '');
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            socket.destroy();
        });

        const port = await listen(server);
        try {
            const proxy = new URL(`http://127.0.0.1:${port}`);
            const targets = [
                'http://example.com',
                'https://example.com',
                'http://example.com:8081',
                'https://example.com:8443'
            ];

            for (const target of targets) {
                await new Promise<void>((resolve, reject) => {
                    const options = buildConnectRequestOptions(proxy, new URL(target), 1000);
                    const req = createProxyConnectRequest(proxy, options);
                    req.on('connect', (_response, socket) => {
                        socket.destroy();
                        req.destroy();
                        resolve();
                    });
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error(`CONNECT timeout for ${target}`));
                    });
                    req.end();
                });
            }

            assert.deepStrictEqual(capturedPaths, [
                'example.com:80',
                'example.com:443',
                'example.com:8081',
                'example.com:8443'
            ]);
        } finally {
            await close(server);
        }
    });

    test('http://127.0.0.1:80 does not connect to a listener on 8080', async function() {
        this.timeout(5000);

        const hitsOn8080: number[] = [];
        const decoy = net.createServer(socket => {
            hitsOn8080.push(1);
            socket.destroy();
        });

        try {
            await new Promise<void>((resolve, reject) => {
                decoy.once('error', reject);
                decoy.listen(8080, '127.0.0.1', () => {
                    decoy.removeListener('error', reject);
                    resolve();
                });
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EADDRINUSE') {
                this.skip();
            }
            throw error;
        }

        try {
            const proxy = new URL('http://127.0.0.1:80');
            const options = buildConnectRequestOptions(proxy, new URL('https://example.com'), 500);
            assert.strictEqual(options.port, 80);

            await new Promise<void>((resolve, reject) => {
                const req = createProxyConnectRequest(proxy, options);
                req.on('error', () => resolve());
                req.on('connect', (_response, socket) => {
                    socket.destroy();
                    req.destroy();
                    resolve();
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve();
                });
                req.end();
            });

            assert.deepStrictEqual(hitsOn8080, [], 'decoy on 8080 must not receive the :80 attempt');
        } finally {
            await new Promise<void>((resolve, reject) => {
                decoy.close(error => error ? reject(error) : resolve());
            });
        }
    });
});
