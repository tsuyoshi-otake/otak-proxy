/**
 * @file utils/ProxyConnectRequest.ts direct CONNECT, Unit Tests
 * @description Issue #108 item 9: the connection test opens its own TCP/TLS
 * connection to the proxy. Inside VS Code `http.request` is patched by
 * @vscode/proxy-agent and could route the test of proxy P through another
 * proxy, so these tests make `http.request` / `https.request` unusable.
 */

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import httpModule = require('http');
import httpsModule = require('https');
import netModule = require('net');
import tlsModule = require('tls');
import {
    testProxyConnection,
    testProxyConnectionParallel
} from '../../utils/ProxyConnectionTest';
import { proxyEndpointVerdict } from '../../utils/ProxyTestFailure';
import { TestResult } from '../../utils/ProxyTestTypes';

const OK_HEAD = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const noop = (): void => undefined;

interface RawProxy {
    port: number;
    /** Request bytes received per connection, in connection order. */
    requests: string[];
    sockets: netModule.Socket[];
    /** Resolves when `count` server-side sockets have closed. */
    closed(count: number): Promise<void>;
    close(): Promise<void>;
}

/**
 * A raw TCP server: `onRequest` gets the CONNECT request text (everything up
 * to the blank line) and the socket, and decides what to answer.
 */
async function listenRaw(
    onRequest: (request: string, socket: netModule.Socket, index: number) => void,
    host = '127.0.0.1'
): Promise<RawProxy> {
    const requests: string[] = [];
    const sockets: netModule.Socket[] = [];
    let closedCount = 0;
    const closeWaiters: Array<{ count: number; resolve: () => void }> = [];
    const server = netModule.createServer(socket => {
        const index = sockets.length;
        sockets.push(socket);
        let received = '';
        socket.on('error', noop);
        socket.on('close', () => {
            closedCount++;
            for (const waiter of closeWaiters) {
                if (closedCount >= waiter.count) {
                    waiter.resolve();
                }
            }
        });
        socket.on('data', chunk => {
            received += chunk.toString('latin1');
            const end = received.indexOf('\r\n\r\n');
            if (end !== -1 && requests[index] === undefined) {
                requests[index] = received.slice(0, end + 4);
                onRequest(requests[index], socket, index);
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const address = server.address() as netModule.AddressInfo;
    return {
        port: address.port,
        requests,
        sockets,
        closed: count => closedCount >= count
            ? Promise.resolve()
            : new Promise<void>(resolve => closeWaiters.push({ count, resolve })),
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    };
}

async function closedPort(): Promise<number> {
    const server = await listenRaw(noop);
    const port = server.port;
    await server.close();
    return port;
}

function connectRequest(authority: string, authorization?: string): string {
    return `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`
        + (authorization ? `Proxy-Authorization: ${authorization}\r\n` : '')
        + '\r\n';
}

function basic(credentials: string): string {
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
}

function findOpenSsl(): string | undefined {
    const candidates = process.platform === 'win32'
        ? ['openssl.exe', path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'openssl.exe')]
        : ['openssl'];
    for (const candidate of candidates) {
        try {
            if (spawnSync(candidate, ['version'], { windowsHide: true }).status === 0) {
                return candidate;
            }
        } catch {
            // try the next candidate
        }
    }
    return undefined;
}

/** Self-signed certificate valid for the IP 127.0.0.1, or undefined without openssl. */
function generateCertificate(): { key: string; cert: string } | undefined {
    const openssl = findOpenSsl();
    if (!openssl) {
        return undefined;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-connect-tls-'));
    try {
        const keyPath = path.join(directory, 'key.pem');
        const certPath = path.join(directory, 'cert.pem');
        const generated = spawnSync(openssl, [
            'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
            '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
        ], { timeout: 30000, windowsHide: true });
        if (generated.status !== 0) {
            return undefined;
        }
        return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function countResources(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) {
        if (name === 'Timeout' || name === 'TCPSocketWrap' || name === 'TLSWRAP') {
            counts[name] = (counts[name] ?? 0) + 1;
        }
    }
    return counts;
}

suite('Proxy connection test uses its own connection (#108 item 9)', () => {
    teardown(() => {
        sinon.restore();
    });

    function forbidHttpRequest(): sinon.SinonStub[] {
        const message = 'http(s).request is patched by VS Code and must not carry the connection test';
        return [
            sinon.stub(httpModule, 'request').throws(new Error(message)),
            sinon.stub(httpsModule, 'request').throws(new Error(message))
        ];
    }

    suite('does not depend on the patched http stack', () => {
        test('a refused proxy is endpointUnreachable and verdict unreachable without http.request', async function() {
            this.timeout(10000);
            const port = await closedPort();
            const stubs = forbidHttpRequest();

            const sequential = await testProxyConnection(`http://127.0.0.1:${port}`, {
                timeout: 1000,
                testUrls: ['https://www.github.com']
            });
            const parallel = await testProxyConnectionParallel(`http://127.0.0.1:${port}`, ['https://www.github.com'], 1000);

            for (const result of [sequential, parallel]) {
                assert.strictEqual(result.failureKind, 'endpointUnreachable', JSON.stringify(result.errors));
                assert.strictEqual(proxyEndpointVerdict(result), 'unreachable');
            }
            assert.ok(stubs.every(stub => stub.notCalled));
        });

        test('connects with net.connect (http proxy) and tls.connect (https proxy) to the proxy host and port', async function() {
            this.timeout(10000);
            const stubs = forbidHttpRequest();
            const netSpy = sinon.spy(netModule, 'connect');
            const tlsSpy = sinon.spy(tlsModule, 'connect');
            const proxy = await listenRaw((_request, socket) => socket.end(OK_HEAD));
            try {
                const plain = await testProxyConnection(`http://127.0.0.1:${proxy.port}`, {
                    timeout: 1000,
                    testUrls: ['https://www.github.com']
                });
                assert.strictEqual(plain.success, true, JSON.stringify(plain.errors));
                assert.strictEqual(netSpy.callCount, 1);
                const netOptions = netSpy.firstCall.args[0] as unknown as netModule.TcpNetConnectOpts;
                assert.strictEqual(netOptions.host, '127.0.0.1');
                assert.strictEqual(netOptions.port, proxy.port);
                assert.ok(tlsSpy.notCalled);

                // The proxy does not speak TLS: only the call is under test.
                await testProxyConnection(`https://127.0.0.1:${proxy.port}`, {
                    timeout: 1000,
                    testUrls: ['https://www.github.com']
                });
                assert.strictEqual(tlsSpy.callCount, 1);
                const tlsOptions = tlsSpy.firstCall.args[0] as unknown as tlsModule.ConnectionOptions;
                assert.strictEqual(tlsOptions.host, '127.0.0.1');
                assert.strictEqual(tlsOptions.port, proxy.port);
                assert.strictEqual(tlsOptions.servername, undefined, 'an IP literal proxy host gets no SNI');
                assert.strictEqual(tlsOptions.ca, undefined, 'no ca: VS Code keeps its certificate injection');
                assert.ok(stubs.every(stub => stub.notCalled));
            } finally {
                await proxy.close();
            }
        });
    });

    suite('request bytes', () => {
        const target = 'example.com:443';

        test('sequential: CONNECT line, Host = target, Basic with percent-decoded credentials', async function() {
            this.timeout(5000);
            const proxy = await listenRaw((_request, socket) => socket.end(OK_HEAD));
            try {
                const result = await testProxyConnection(`http://user:p%40ss@127.0.0.1:${proxy.port}`, {
                    timeout: 1000,
                    testUrls: ['https://example.com']
                });
                assert.strictEqual(result.success, true, JSON.stringify(result.errors));
                assert.deepStrictEqual(proxy.requests, [connectRequest(target, basic('user:p@ss'))]);
            } finally {
                await proxy.close();
            }
        });

        test('sequential: no credentials means no Proxy-Authorization line', async function() {
            this.timeout(5000);
            const proxy = await listenRaw((_request, socket) => socket.end(OK_HEAD));
            try {
                await testProxyConnection(`http://127.0.0.1:${proxy.port}`, {
                    timeout: 1000,
                    testUrls: ['http://example.com:8081']
                });
                assert.deepStrictEqual(proxy.requests, [connectRequest('example.com:8081')]);
            } finally {
                await proxy.close();
            }
        });

        test('parallel: every attempt sends its own target authority', async function() {
            this.timeout(5000);
            const proxy = await listenRaw(() => undefined);
            try {
                const expected = [
                    connectRequest('a.example:443', basic('user:p@ss')),
                    connectRequest('b.example:8443', basic('user:p@ss')),
                    connectRequest('c.example:80', basic('user:p@ss'))
                ];
                const result = await testProxyConnectionParallel(
                    `http://user:p%40ss@127.0.0.1:${proxy.port}`,
                    ['https://a.example', 'https://b.example:8443', 'http://c.example'],
                    300
                );
                assert.strictEqual(result.failureKind, 'timeout');
                assert.deepStrictEqual([...proxy.requests].sort(), [...expected].sort());
            } finally {
                await proxy.close();
            }
        });

        test('a CR LF in a percent-encoded password cannot add a header line', async function() {
            this.timeout(5000);
            const proxy = await listenRaw((_request, socket) => socket.end(OK_HEAD));
            try {
                const proxyUrl = `http://user:pa%0D%0Ass@127.0.0.1:${proxy.port}`;
                const sequential = await testProxyConnection(proxyUrl, {
                    timeout: 1000,
                    testUrls: ['https://example.com']
                });
                const parallel = await testProxyConnectionParallel(proxyUrl, ['https://example.com'], 1000);
                assert.strictEqual(sequential.success, true, JSON.stringify(sequential.errors));
                assert.strictEqual(parallel.success, true, JSON.stringify(parallel.errors));

                const expected = connectRequest(target, basic('user:pa\r\nss'));
                assert.strictEqual(proxy.requests[0], expected);
                assert.strictEqual(proxy.requests[0].split('\r\n').length, 5, 'CONNECT, Host, one Proxy-Authorization, blank, end');
                assert.strictEqual(proxy.requests[1], expected);
            } finally {
                await proxy.close();
            }
        });

        test('an IPv6 target keeps its brackets in CONNECT and Host', async function() {
            this.timeout(5000);
            let proxy: RawProxy;
            try {
                proxy = await listenRaw((_request, socket) => socket.end(OK_HEAD), '::1');
            } catch {
                this.skip();
                return;
            }
            try {
                const result = await testProxyConnection(`http://[::1]:${proxy.port}`, {
                    timeout: 1000,
                    testUrls: ['https://[2001:db8::1]/']
                });
                assert.strictEqual(result.success, true, JSON.stringify(result.errors));
                assert.deepStrictEqual(proxy.requests, [connectRequest('[2001:db8::1]:443')]);
            } finally {
                await proxy.close();
            }
        });
    });

    suite('response head', () => {
        interface HeadCase {
            name: string;
            reply: (socket: netModule.Socket) => void;
            expectedKind?: TestResult['failureKind'];
        }

        const headCases: HeadCase[] = [
            { name: 'status line without a reason phrase', reply: s => s.write('HTTP/1.1 200\r\n\r\n') },
            { name: 'status line with an empty reason phrase', reply: s => s.write('HTTP/1.1 200 \r\n\r\n') },
            { name: 'HTTP/1.0 status line', reply: s => s.write('HTTP/1.0 200 OK\r\n\r\n') },
            { name: '200 head followed by body bytes', reply: s => s.write(`${OK_HEAD}SSH-2.0-body\r\n`) },
            { name: 'LF-only head', reply: s => s.write('HTTP/1.1 200 OK\n\n'), expectedKind: 'protocol' },
            { name: 'a non-HTTP greeting', reply: s => s.write('SSH-2.0-OpenSSH_9.0\r\n'), expectedKind: 'protocol' },
            {
                name: '16 KiB without a blank line',
                reply: s => s.write(`HTTP/1.1 200 OK\r\nX-Pad: ${'a'.repeat(16 * 1024)}`),
                expectedKind: 'protocol'
            },
            {
                name: '407 with a 10 KiB header block',
                reply: s => s.write(`HTTP/1.1 407 Proxy Authentication Required\r\nX-Pad: ${'a'.repeat(10 * 1024)}\r\n\r\n`),
                expectedKind: 'authRequired'
            },
            {
                name: 'status line then close before the blank line',
                reply: s => s.end('HTTP/1.1 502 Bad Gateway\r\n'),
                expectedKind: 'unknown'
            }
        ];

        for (const headCase of headCases) {
            test(headCase.name, async function() {
                this.timeout(5000);
                const proxy = await listenRaw((_request, socket) => headCase.reply(socket));
                try {
                    const sequential = await testProxyConnection(`http://127.0.0.1:${proxy.port}`, {
                        timeout: 2000,
                        testUrls: ['https://www.github.com']
                    });
                    const parallel = await testProxyConnectionParallel(
                        `http://127.0.0.1:${proxy.port}`,
                        ['https://www.github.com'],
                        2000
                    );
                    for (const result of [sequential, parallel]) {
                        assert.strictEqual(result.success, headCase.expectedKind === undefined, JSON.stringify(result.errors));
                        assert.strictEqual(result.failureKind, headCase.expectedKind);
                        assert.strictEqual(result.proxyConnected, true);
                    }
                } finally {
                    await proxy.close();
                }
            });
        }

        test('a refused localhost proxy (AggregateError with an empty message) is endpointUnreachable', async function() {
            this.timeout(10000);
            const port = await closedPort();
            const result = await testProxyConnection(`http://localhost:${port}`, {
                timeout: 3000,
                testUrls: ['https://www.github.com']
            });
            assert.strictEqual(result.failureKind, 'endpointUnreachable', JSON.stringify(result.errors));
            assert.strictEqual(proxyEndpointVerdict(result), 'unreachable');
        });
    });

    suite('hang after connect', () => {
        const urls = ['https://a.example', 'https://b.example', 'https://c.example'];

        test('sequential and parallel give timeout with proxyConnected', async function() {
            this.timeout(10000);
            const proxy = await listenRaw(noop);
            try {
                const sequential = await testProxyConnection(`http://127.0.0.1:${proxy.port}`, {
                    timeout: 200,
                    testUrls: ['https://www.github.com']
                });
                const parallel = await testProxyConnectionParallel(`http://127.0.0.1:${proxy.port}`, ['https://www.github.com'], 200);
                for (const result of [sequential, parallel]) {
                    assert.strictEqual(result.failureKind, 'timeout', JSON.stringify(result.errors));
                    assert.strictEqual(result.proxyConnected, true);
                    assert.strictEqual(proxyEndpointVerdict(result), 'alive');
                }
            } finally {
                await proxy.close();
            }
        });

        test('parallel reports each hanging target exactly once', async function() {
            this.timeout(10000);
            const proxy = await listenRaw(noop);
            try {
                const result = await testProxyConnectionParallel(`http://127.0.0.1:${proxy.port}`, urls, 200);
                await proxy.closed(urls.length);
                assert.strictEqual(result.proxyConnected, true);
                assert.deepStrictEqual(
                    result.errors.map(error => [error.url, error.failureKind]).sort(),
                    urls.map(url => [url, 'timeout']).sort()
                );
            } finally {
                await proxy.close();
            }
        });

        test('a head that keeps trickling is cut by the sequential watchdog and the socket is closed', async function() {
            this.timeout(10000);
            const timers: NodeJS.Timeout[] = [];
            const proxy = await listenRaw((_request, socket) => {
                socket.write('HTTP/1.1 200 OK\r\nX: ');
                timers.push(setInterval(() => socket.write('a'), 20));
            });
            try {
                const result = await testProxyConnection(`http://127.0.0.1:${proxy.port}`, {
                    timeout: 300,
                    testUrls: ['https://www.github.com']
                });
                assert.strictEqual(result.failureKind, 'timeout');
                assert.strictEqual(result.proxyConnected, true);
                await proxy.closed(1);
            } finally {
                timers.forEach(clearInterval);
                await proxy.close();
            }
        });

        test('a head that keeps trickling is cut by the parallel overall timeout', async function() {
            this.timeout(10000);
            const timers: NodeJS.Timeout[] = [];
            const proxy = await listenRaw((_request, socket) => {
                socket.write('HTTP/1.1 200 OK\r\nX: ');
                timers.push(setInterval(() => socket.write('a'), 20));
            });
            try {
                const result = await testProxyConnectionParallel(`http://127.0.0.1:${proxy.port}`, ['https://www.github.com'], 200);
                assert.strictEqual(result.failureKind, 'timeout');
                assert.ok(result.errors.some(error => error.url === 'All tests'), JSON.stringify(result.errors));
                assert.strictEqual(result.proxyConnected, true);
                await proxy.closed(1);
            } finally {
                timers.forEach(clearInterval);
                await proxy.close();
            }
        });
    });

    suite('parallel cleanup', () => {
        test('settles once on the first success, closes the other sockets and leaves no timer behind', async function() {
            this.timeout(10000);
            const proxy = await listenRaw((_request, socket, index) => {
                if (index === 0) {
                    socket.write(OK_HEAD);
                }
            });
            try {
                const before = countResources();
                const result = await testProxyConnectionParallel(
                    `http://127.0.0.1:${proxy.port}`,
                    ['https://a.example', 'https://b.example', 'https://c.example'],
                    5000
                );
                assert.strictEqual(result.success, true, JSON.stringify(result.errors));
                assert.deepStrictEqual(result.errors, []);

                await proxy.closed(3);
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.deepStrictEqual(result.errors, [], 'a cancelled loser must not add an error afterwards');
                assert.deepStrictEqual(
                    countResources(),
                    before,
                    `before: ${JSON.stringify(before)}, after: ${JSON.stringify(process.getActiveResourcesInfo())}`
                );
            } finally {
                await proxy.close();
            }
        });
    });

    suite('TLS proxy', () => {
        interface TlsProxy {
            port: number;
            close(): Promise<void>;
        }

        async function listenTls(credentials: { key: string; cert: string }): Promise<TlsProxy> {
            const sockets: netModule.Socket[] = [];
            const server = tlsModule.createServer(credentials, socket => {
                sockets.push(socket);
                socket.on('error', noop);
                socket.once('data', () => socket.end(OK_HEAD));
            });
            server.on('tlsClientError', noop);
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            return {
                port: (server.address() as netModule.AddressInfo).port,
                close: async () => {
                    sockets.forEach(socket => socket.destroy());
                    await new Promise<void>(resolve => server.close(() => resolve()));
                }
            };
        }

        test('trusted certificate succeeds, an untrusted one is protocol and not proof of life', async function() {
            this.timeout(60000);
            const credentials = generateCertificate();
            if (!credentials) {
                this.skip();
                return;
            }
            const proxy = await listenTls(credentials);
            try {
                const untrusted = await testProxyConnection(`https://127.0.0.1:${proxy.port}`, {
                    timeout: 3000,
                    testUrls: ['https://www.github.com']
                });
                assert.strictEqual(untrusted.failureKind, 'protocol', JSON.stringify(untrusted.errors));
                assert.notStrictEqual(untrusted.proxyConnected, true);
                assert.strictEqual(proxyEndpointVerdict(untrusted), 'unknown');

                // Production passes no ca: trust the test certificate from the outside.
                const originalConnect = tlsModule.connect;
                sinon.stub(tlsModule, 'connect').callsFake(
                    ((options: tlsModule.ConnectionOptions) =>
                        originalConnect({ ...options, ca: credentials.cert })) as typeof tlsModule.connect
                );
                const trusted = await testProxyConnection(`https://user:pw@127.0.0.1:${proxy.port}`, {
                    timeout: 3000,
                    testUrls: ['https://www.github.com']
                });
                assert.strictEqual(trusted.success, true, JSON.stringify(trusted.errors));
                assert.strictEqual(trusted.proxyConnected, true);

                const parallel = await testProxyConnectionParallel(
                    `https://127.0.0.1:${proxy.port}`,
                    ['https://www.github.com'],
                    3000
                );
                assert.strictEqual(parallel.success, true, JSON.stringify(parallel.errors));
            } finally {
                await proxy.close();
            }
        });
    });
});
