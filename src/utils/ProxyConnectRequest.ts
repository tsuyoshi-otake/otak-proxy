import * as http from 'http';
import * as https from 'https';
import { stripIpv6Brackets } from '../validation/ProxyHost';

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;

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
        hostname: stripIpv6Brackets(proxy.hostname),
        port: parsePort(proxy.port, getSchemeDefaultPort(proxy)),
        method: 'CONNECT',
        path: `${target.hostname}:${parsePort(target.port, getSchemeDefaultPort(target))}`,
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

/**
 * Credential-free destination summary for failure logs.
 * Never include headers, username, or password.
 */
export function formatConnectDestination(options: http.RequestOptions): string {
    const hostname = typeof options.hostname === 'string' && options.hostname.length > 0
        ? options.hostname
        : 'unknown-host';
    const port = options.port ?? '';
    const connectPath = typeof options.path === 'string' ? options.path : '';
    return `proxy ${hostname}:${port} CONNECT ${connectPath}`;
}
