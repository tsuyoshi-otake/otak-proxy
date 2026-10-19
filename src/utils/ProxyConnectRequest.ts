import * as net from 'net';
import * as tls from 'tls';
import { stripIpv6Brackets } from '../validation/ProxyHost';

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

/** Node's default `maxHeaderSize`: the longest response head still read. */
const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;
const RESPONSE_HEAD_TERMINATOR = '\r\n\r\n';
const RESPONSE_VERSION_PREFIX = 'HTTP/';
const STATUS_LINE_PATTERN = /^HTTP\/\d\.\d (\d{3})(?: ([^\r\n]*))?$/;

/** What `connectThroughProxy` needs: the proxy endpoint and the CONNECT it sends. */
export interface ConnectRequestOptions {
    /** Proxy host without IPv6 brackets. */
    host: string;
    port: number;
    /** True for an `https:` proxy: the connection to the proxy is TLS. */
    tls: boolean;
    /** CONNECT target as `host:port` (IPv6 targets keep their brackets). */
    authority: string;
    /** Value of `Proxy-Authorization`, when the proxy URL carries credentials. */
    proxyAuthorization?: string;
    /** Idle timeout of the connection to the proxy, in milliseconds. */
    timeout: number;
}

export interface ConnectResponse {
    statusCode: number;
    statusMessage: string;
}

export interface ProxyConnectHandle {
    /** Settles once; rejects with the original socket error where there is one. */
    result: Promise<ConnectResponse>;
    /** Aborts an outstanding attempt (rejects with `ECANCELLED`); no-op once settled. */
    cancel(): void;
}

function parsePort(port: string, fallback: number): number {
    const parsed = Number(port);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getSchemeDefaultPort(url: URL): number {
    return url.protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;
}

function decodeProxyCredential(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function buildProxyAuthorizationHeader(proxy: URL): string | undefined {
    if (!proxy.username && !proxy.password) {
        return undefined;
    }

    const username = decodeProxyCredential(proxy.username);
    const password = decodeProxyCredential(proxy.password);
    const credentials = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${credentials}`;
}

export function buildConnectRequestOptions(
    proxy: URL,
    target: URL,
    timeout: number
): ConnectRequestOptions {
    return {
        host: stripIpv6Brackets(proxy.hostname),
        port: parsePort(proxy.port, getSchemeDefaultPort(proxy)),
        tls: proxy.protocol === 'https:',
        authority: `${target.hostname}:${parsePort(target.port, getSchemeDefaultPort(target))}`,
        proxyAuthorization: buildProxyAuthorizationHeader(proxy),
        timeout
    };
}

export function isConnectResponseSuccessful(response: Pick<ConnectResponse, 'statusCode'>): boolean {
    return response.statusCode >= 200 && response.statusCode < 300;
}

export function formatConnectFailure(response: ConnectResponse): string {
    const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
    return `Proxy CONNECT failed with status ${response.statusCode}${statusMessage}`;
}

/**
 * Credential-free destination summary for failure logs.
 * Never include headers, username, or password.
 */
export function formatConnectDestination(options: ConnectRequestOptions): string {
    return `proxy ${options.host}:${options.port} CONNECT ${options.authority}`;
}

function buildConnectRequest(options: ConnectRequestOptions): string {
    return `CONNECT ${options.authority} HTTP/1.1\r\n`
        + `Host: ${options.authority}\r\n`
        + (options.proxyAuthorization ? `Proxy-Authorization: ${options.proxyAuthorization}\r\n` : '')
        + '\r\n';
}

type ResponseHead = ConnectResponse | 'incomplete' | 'malformed';

/**
 * Reads the CONNECT response head from the bytes received so far. The head
 * ends at the first CRLF CRLF; only its status line is validated, and body
 * bytes after it are ignored. A bare LF line end or a non-HTTP greeting is
 * malformed as soon as it is seen, not when the connection ends.
 */
function parseResponseHead(received: Buffer): ResponseHead {
    const prefixLength = Math.min(received.length, RESPONSE_VERSION_PREFIX.length);
    if (received.toString('latin1', 0, prefixLength) !== RESPONSE_VERSION_PREFIX.slice(0, prefixLength)) {
        return 'malformed';
    }

    const lineEnd = received.indexOf('\n');
    if (lineEnd === -1) {
        return received.length >= MAX_RESPONSE_HEAD_BYTES ? 'malformed' : 'incomplete';
    }
    if (received[lineEnd - 1] !== 0x0d) {
        return 'malformed';
    }

    const statusLine = STATUS_LINE_PATTERN.exec(received.toString('latin1', 0, lineEnd - 1));
    if (!statusLine) {
        return 'malformed';
    }

    const headEnd = received.indexOf(RESPONSE_HEAD_TERMINATOR);
    if (headEnd === -1) {
        return received.length >= MAX_RESPONSE_HEAD_BYTES ? 'malformed' : 'incomplete';
    }
    if (headEnd + RESPONSE_HEAD_TERMINATOR.length > MAX_RESPONSE_HEAD_BYTES) {
        return 'malformed';
    }

    return { statusCode: Number(statusLine[1]), statusMessage: statusLine[2] ?? '' };
}

function connectError(message: string, code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(message);
    error.code = code;
    return error;
}

/**
 * Sends one CONNECT straight to the proxy over its own TCP (`http:` proxy) or
 * TLS (`https:` proxy) connection.
 *
 * It does not use `http.request`: inside VS Code those modules are patched by
 * `@vscode/proxy-agent`, which resolves a proxy for the request itself. The
 * test of proxy P could then travel through another proxy, and a refusal of P
 * would surface without an errno. `net.connect` and `tls.connect` are patched
 * too, but only for certificates, never for proxy routing. No `ca` is passed,
 * so VS Code's certificate injection stays active and an `https:` proxy
 * certificate is checked against Node's CA list, `NODE_EXTRA_CA_CERTS`, and
 * the OS store only in VS Code's certificate mode V2.
 *
 * `onProxyConnected` fires once the endpoint is proven up: on `connect` for an
 * `http:` proxy, on `secureConnect` for an `https:` proxy. A TLS socket
 * reports `connect` before its handshake, which can still fail, so only a
 * finished handshake proves that an `https:` proxy answers (#97).
 *
 * Every rejection is the error to classify with `classifyConnectError`:
 * socket errors keep their `code`; an idle timeout is `ETIMEDOUT`; a malformed
 * or oversized response head is `EPROTO`; a close before a complete head is
 * `ECONNRESET` ("socket hang up", as Node's HTTP client reports it).
 * The socket is destroyed on every path.
 */
export function connectThroughProxy(
    options: ConnectRequestOptions,
    onProxyConnected?: () => void
): ProxyConnectHandle {
    const socket = options.tls
        ? tls.connect({
            host: options.host,
            port: options.port,
            ...(net.isIP(options.host) === 0 ? { servername: options.host } : {})
        })
        : net.connect({ host: options.host, port: options.port });

    let abort: (error: Error) => void = () => undefined;
    const result = new Promise<ConnectResponse>((resolve, reject) => {
        let settled = false;
        let received = Buffer.alloc(0);

        const settle = (finish: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            finish();
        };
        abort = error => settle(() => reject(error));

        socket.once(options.tls ? 'secureConnect' : 'connect', () => {
            onProxyConnected?.();
            socket.write(buildConnectRequest(options));
        });
        socket.setTimeout(options.timeout, () => {
            abort(connectError(`Connection timeout (${options.timeout}ms)`, 'ETIMEDOUT'));
        });
        socket.on('error', abort);
        socket.on('close', () => {
            abort(connectError('socket hang up', 'ECONNRESET'));
        });
        socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            const head = parseResponseHead(received);
            if (head === 'malformed') {
                abort(connectError('Proxy returned a malformed CONNECT response', 'EPROTO'));
            } else if (head !== 'incomplete') {
                settle(() => resolve(head));
            }
        });
    });

    return {
        result,
        cancel: () => abort(connectError('Proxy CONNECT cancelled', 'ECANCELLED'))
    };
}
