/**
 * @file Connection test inside the VS Code extension host (Issue #108 item 9)
 * @description Inside the host, `http`/`https` are patched by @vscode/proxy-agent,
 * which sends a request through `http.proxy`. The connection test of proxy P
 * must not travel through that other proxy A. proxy-agent resolves localhost,
 * 127.0.0.1, ::1 and ::ffff:127.0.0.1 DIRECT before anything else, so the
 * loopback tests of the unit lane never saw the bug; 127.0.0.2 is not on that
 * list.
 */

import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { testProxyConnection } from '../../utils/ProxyConnectionTest';

const CANARY_TRIES = 20;
const CANARY_INTERVAL_MS = 100;

interface Recorder {
    port: number;
    connections(): number;
    reset(): void;
    close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function listenRecorder(): Promise<Recorder> {
    let count = 0;
    const sockets: net.Socket[] = [];
    const server = net.createServer(socket => {
        count++;
        sockets.push(socket);
        socket.on('error', () => undefined);
        socket.once('data', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    return {
        port: (server.address() as net.AddressInfo).port,
        connections: () => count,
        reset: () => {
            count = 0;
        },
        close: async () => {
            sockets.forEach(socket => socket.destroy());
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    };
}

/** A port nobody listens on, on 127.0.0.2; undefined when the host has no such loopback alias. */
async function closedPortOn127002(): Promise<number | undefined> {
    const server = net.createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.2', () => resolve());
        });
    } catch {
        return undefined;
    }
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}

function connectRefused(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
    });
}

function exemptsLoopback(value: string | undefined): boolean {
    return (value ?? '').split(',').some(entry => /^\s*(\*|127\.)/.test(entry));
}

/** One plain http.request, no agent: the patched stack decides where it goes. */
function sendCanary(port: number): Promise<void> {
    return new Promise(resolve => {
        const request = http.request({ host: '127.0.0.2', port, path: '/', timeout: 1000 }, response => {
            response.resume();
            resolve();
        });
        request.on('error', () => resolve());
        request.on('timeout', () => request.destroy());
        request.end();
    });
}

suite('Proxy connection test in the VS Code host (#108 item 9)', () => {
    test('the test of a refused proxy does not travel through http.proxy', async function() {
        this.timeout(60000);

        const closedPort = await closedPortOn127002();
        if (closedPort === undefined || !await connectRefused('127.0.0.2', closedPort)) {
            this.skip();
            return;
        }
        const httpConfig = vscode.workspace.getConfiguration('http');
        if (
            exemptsLoopback(process.env.NO_PROXY) ||
            exemptsLoopback(process.env.no_proxy) ||
            (httpConfig.get<string[]>('noProxy') ?? []).some(entry => /^\s*(\*|127\.)/.test(entry))
        ) {
            this.skip();
            return;
        }

        const recorder = await listenRecorder();
        const previous = httpConfig.inspect<string>('proxy')?.globalValue;
        const changed = new Promise<void>(resolve => {
            const subscription = vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('http.proxy')) {
                    subscription.dispose();
                    resolve();
                }
            });
        });
        try {
            await httpConfig.update('proxy', `http://127.0.0.1:${recorder.port}`, vscode.ConfigurationTarget.Global);
            await changed;

            // Readiness canary: the host must send a plain http.request through http.proxy now.
            let routed = false;
            for (let attempt = 0; attempt < CANARY_TRIES && !routed; attempt++) {
                await sendCanary(closedPort);
                routed = recorder.connections() > 0;
                if (!routed) {
                    await delay(CANARY_INTERVAL_MS);
                }
            }
            if (!routed) {
                console.log('Item 9 not reproducible here: the host does not send http.request through http.proxy '
                    + '(for example http.proxySupport is off, or http.noProxy exempts 127.0.0.2).');
                this.skip();
                return;
            }
            recorder.reset();

            const result = await testProxyConnection(`http://127.0.0.2:${closedPort}`, {
                timeout: 5000,
                testUrls: ['https://www.github.com']
            });

            assert.strictEqual(
                result.failureKind,
                'endpointUnreachable',
                `errors: ${JSON.stringify(result.errors)}, connections to http.proxy: ${recorder.connections()}`
            );
            assert.strictEqual(recorder.connections(), 0, 'the test must not go through http.proxy');
        } finally {
            await httpConfig.update('proxy', previous, vscode.ConfigurationTarget.Global);
            await recorder.close();
        }
    });
});
