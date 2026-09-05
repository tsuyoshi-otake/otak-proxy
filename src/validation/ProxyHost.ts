import * as net from 'net';

/**
 * DNS labels stay alphanumeric / dot / hyphen only.
 * Do not add `:`; IPv6 is a separate semantic branch (Issue #53).
 */
export const DNS_HOSTNAME_PATTERN = /^[a-zA-Z0-9.-]+$/;

export const INVALID_DNS_HOSTNAME_ERROR =
    'Hostname contains invalid characters (only alphanumeric, dots, and hyphens allowed)';

export const IPV6_BRACKETS_REQUIRED_ERROR =
    'IPv6 addresses must be enclosed in brackets (for example http://[::1]:8080)';

export const INVALID_IPV6_HOSTNAME_ERROR = 'Hostname is not a valid IPv6 address';

export type ProxyHostKind = 'dns' | 'ipv4' | 'ipv6';

export type ProxyHostClassification =
    | { ok: true; kind: ProxyHostKind; hostname: string }
    | { ok: false; error: string };

export function stripIpv6Brackets(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']') && hostname.length >= 2) {
        return hostname.slice(1, -1);
    }
    return hostname;
}

/**
 * Classify a WHATWG hostname (Node keeps IPv6 brackets).
 * Input authority brackets are enforced separately before parse.
 */
export function classifyProxyHostname(hostname: string): ProxyHostClassification {
    if (!hostname) {
        return { ok: false, error: 'Hostname is required' };
    }

    const unbracketed = stripIpv6Brackets(hostname);
    if (hostname.startsWith('[') || net.isIPv6(unbracketed)) {
        if (!net.isIPv6(unbracketed)) {
            return { ok: false, error: INVALID_IPV6_HOSTNAME_ERROR };
        }
        return { ok: true, kind: 'ipv6', hostname: unbracketed };
    }

    if (net.isIPv4(hostname)) {
        return { ok: true, kind: 'ipv4', hostname };
    }

    if (DNS_HOSTNAME_PATTERN.test(hostname)) {
        return { ok: true, kind: 'dns', hostname };
    }

    return { ok: false, error: INVALID_DNS_HOSTNAME_ERROR };
}

function looksLikeUnbracketedIpv6(host: string): boolean {
    return net.isIPv6(host) || (host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host));
}

/**
 * Validate raw authority after `http(s)://` (optional userinfo + host[:port]).
 */
export function describeInvalidProxyAuthority(authority: string): string | null {
    if (/[/?#\s\\]/.test(authority)) {
        return INVALID_DNS_HOSTNAME_ERROR;
    }

    const parts = authority.split('@');
    if (parts.length > 2) {
        return INVALID_DNS_HOSTNAME_ERROR;
    }

    const hostPort = parts[parts.length - 1];
    if (!hostPort) {
        return 'Hostname is required';
    }

    if (hostPort.startsWith('[')) {
        const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
        if (!match || !net.isIPv6(match[1])) {
            return INVALID_IPV6_HOSTNAME_ERROR;
        }
        return null;
    }

    if (hostPort.includes(':')) {
        const lastColon = hostPort.lastIndexOf(':');
        const host = hostPort.slice(0, lastColon);
        if (!host || looksLikeUnbracketedIpv6(host)) {
            return IPV6_BRACKETS_REQUIRED_ERROR;
        }
        if (host.includes(':')) {
            return INVALID_DNS_HOSTNAME_ERROR;
        }
        // Port is checked after WHATWG parse so invalid ports keep their existing errors.
        const classified = classifyProxyHostname(host);
        return classified.ok ? null : classified.error;
    }

    if (net.isIPv6(hostPort)) {
        return IPV6_BRACKETS_REQUIRED_ERROR;
    }

    const classified = classifyProxyHostname(hostPort);
    return classified.ok ? null : classified.error;
}
