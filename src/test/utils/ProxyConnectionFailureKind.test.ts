import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import {
    testProxyConnection,
    testProxyConnectionParallel
} from '../../utils/ProxyConnectionTest';
import { TestResult } from '../../utils/ProxyTestTypes';

suite('Proxy connection failure classification', () => {
    async function listen(server: http.Server | net.Server): Promise<number> {
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

    async function close(server: http.Server | net.Server): Promise<void> {
        const closable = server as http.Server & { closeAllConnections?: () => void };
        closable.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }

    function connectStub(statusLine: string): http.Server {
        const server = http.createServer();
        server.on('connect', (_request, socket) => {
            socket.write(statusLine);
            socket.destroy();
        });
        return server;
    }

    async function assertClassifiedFailure(
        result: TestResult,
        expectedKind: TestResult['failureKind'],
        messageNeedle?: string
    ): Promise<void> {
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.failureKind, expectedKind);
        assert.ok(result.canaryHost, 'canaryHost should be present');
        assert.ok(
            !result.proxyUrl || !result.proxyUrl.includes('@'),
            'classified result must not carry an authenticated proxy URL'
        );
        if (messageNeedle) {
            assert.ok(
                result.errors.some(error => error.message.includes(messageNeedle)),
                `Expected error message to include ${messageNeedle}, got: ${JSON.stringify(result.errors)}`
            );
        }
    }

    test('CONNECT 407 is authRequired and keeps the existing status message', async function() {
        this.timeout(5000);
        const server = connectStub('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        const port = await listen(server);
        try {
            const result = await testProxyConnection(`http://127.0.0.1:${port}`, {
                timeout: 1000,
                testUrls: ['https://www.github.com']
            });
            await assertClassifiedFailure(result, 'authRequired', '407');
            assert.strictEqual(result.proxyEndpointOk, true);
            assert.strictEqual(result.canaryHost, 'www.github.com');
        } finally {
            await close(server);
        }
    });

    test('CONNECT 403 is destinationForbidden', async function() {
        this.timeout(5000);
        const server = connectStub('HTTP/1.1 403 Forbidden\r\n\r\n');
        const port = await listen(server);
        try {
            const result = await testProxyConnection(`http://127.0.0.1:${port}`, {
                timeout: 1000,
                testUrls: ['https://www.google.com']
            });
            await assertClassifiedFailure(result, 'destinationForbidden', '403');
            assert.strictEqual(result.proxyEndpointOk, true);
        } finally {
            await close(server);
        }
    });

    test('CONNECT 502 is connectRejected', async function() {
        this.timeout(5000);
        const server = connectStub('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        const port = await listen(server);
        try {
            const result = await testProxyConnectionParallel(
                `http://127.0.0.1:${port}`,
                ['https://www.microsoft.com'],
                1000
            );
            await assertClassifiedFailure(result, 'connectRejected', '502');
            assert.strictEqual(result.proxyEndpointOk, true);
        } finally {
            await close(server);
        }
    });

    test('ECONNREFUSED is endpointUnreachable', async function() {
        this.timeout(5000);
        const server = http.createServer();
        const port = await listen(server);
        await close(server);

        const result = await testProxyConnection(`http://127.0.0.1:${port}`, {
            timeout: 1000,
            testUrls: ['https://www.github.com']
        });
        await assertClassifiedFailure(result, 'endpointUnreachable');
        assert.strictEqual(result.proxyEndpointOk, false);
    });

    test('CONNECT hang is timeout, not endpointUnreachable', async function() {
        this.timeout(5000);
        const sockets: net.Socket[] = [];
        const server = net.createServer(socket => {
            sockets.push(socket);
        });
        const port = await listen(server);
        try {
            const result = await testProxyConnection(`http://127.0.0.1:${port}`, {
                timeout: 200,
                testUrls: ['https://www.github.com']
            });
            await assertClassifiedFailure(result, 'timeout', 'timeout');
            assert.notStrictEqual(result.failureKind, 'endpointUnreachable');
            assert.strictEqual(result.proxyEndpointOk, false);
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }
            await close(server);
        }
    });

    test('unresolvable proxy host is dns', async function() {
        this.timeout(10000);
        const result = await testProxyConnection('http://no-such-host.invalid:8080', {
            timeout: 2000,
            testUrls: ['https://www.github.com']
        });
        await assertClassifiedFailure(result, 'dns');
        assert.notStrictEqual(result.failureKind, 'endpointUnreachable');
    });
});
