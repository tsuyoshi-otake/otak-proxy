import * as http from 'http';
import * as https from 'https';

const DEFAULT_HTTP_PROXY_PORT = 8080;
const DEFAULT_HTTPS_PROXY_PORT = 443;
const DEFAULT_TARGET_PORT = 443;

function parsePort(port: string, fallback: number): number {
    const parsed = Number(port);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDefaultProxyPort(proxy: URL): number {
    return proxy.protocol === 'https:' ? DEFAULT_HTTPS_PROXY_PORT : DEFAULT_HTTP_PROXY_PORT;
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

export function createProxyConnectRequest(
    proxy: URL,
    requestOptions: http.RequestOptions
): http.ClientRequest {
    const transport = proxy.protocol === 'https:' ? https : http;
    return transport.request(requestOptions);
}

export function buildConnectRequestOptions(
    proxy: URL,
    target: URL,
    timeout: number
): http.RequestOptions {
    const proxyAuthorization = buildProxyAuthorizationHeader(proxy);
    return {
        hostname: proxy.hostname,
        port: parsePort(proxy.port, getDefaultProxyPort(proxy)),
        method: 'CONNECT',
        path: `${target.hostname}:${parsePort(target.port, DEFAULT_TARGET_PORT)}`,
        timeout,
        headers: proxyAuthorization ? { 'Proxy-Authorization': proxyAuthorization } : undefined
    };
}

export function isConnectResponseSuccessful(response: http.IncomingMessage): boolean {
    const statusCode = response.statusCode ?? 0;
    return statusCode >= 200 && statusCode < 300;
}

export function formatConnectFailure(response: http.IncomingMessage): string {
    const statusCode = response.statusCode ?? 'unknown';
    const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : '';
    return `Proxy CONNECT failed with status ${statusCode}${statusMessage}`;
}
