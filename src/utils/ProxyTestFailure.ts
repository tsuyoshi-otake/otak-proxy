import { ProxyTestFailureKind, TestResult, TestUrlError } from './ProxyTestTypes';

const PROXY_RESPONSE_KINDS: readonly ProxyTestFailureKind[] = [
    'authRequired',
    'destinationForbidden',
    'connectRejected'
];

const AGGREGATE_KIND_PRIORITY: readonly ProxyTestFailureKind[] = [
    'authRequired',
    'destinationForbidden',
    'connectRejected',
    'timeout',
    'dns',
    'protocol',
    'unknown',
    'endpointUnreachable'
];

export function classifyConnectStatus(statusCode: number): ProxyTestFailureKind {
    if (statusCode === 407) {
        return 'authRequired';
    }
    if (statusCode === 403) {
        return 'destinationForbidden';
    }
    if (statusCode >= 500 && statusCode <= 599) {
        return 'connectRejected';
    }
    return 'unknown';
}

export function classifyConnectError(error: Error | string): ProxyTestFailureKind {
    const code = typeof error === 'string' ? undefined : (error as NodeJS.ErrnoException).code;
    const message = typeof error === 'string' ? error : `${error.message} ${code ?? ''}`;

    if (
        code === 'ECONNREFUSED' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH' ||
        /\bECONNREFUSED\b/.test(message) ||
        /\bEHOSTUNREACH\b/.test(message) ||
        /\bENETUNREACH\b/.test(message)
    ) {
        return 'endpointUnreachable';
    }

    if (
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        /\bENOTFOUND\b/.test(message) ||
        /\bEAI_AGAIN\b/.test(message) ||
        /getaddrinfo/i.test(message)
    ) {
        return 'dns';
    }

    if (code === 'ETIMEDOUT' || /timeout|ETIMEDOUT/i.test(message)) {
        return 'timeout';
    }

    if (
        code === 'EPROTO' ||
        /certificate|SSL|TLS|EPROTO|protocol|Invalid URL/i.test(message)
    ) {
        return 'protocol';
    }

    return 'unknown';
}

export function summarizeFailedProxyTest(
    errors: readonly TestUrlError[],
    testUrls: readonly string[]
): Pick<TestResult, 'failureKind' | 'proxyEndpointOk' | 'canaryHost'> {
    const kinds = errors.map(error => error.failureKind ?? classifyConnectError(error.message));
    const proxyEndpointOk = kinds.some(kind => PROXY_RESPONSE_KINDS.includes(kind));
    const failureKind = pickAggregateKind(kinds);
    return {
        failureKind,
        proxyEndpointOk,
        canaryHost: extractCanaryHost(errors, testUrls)
    };
}

export function isProxyEndpointUnreachable(
    result: Pick<TestResult, 'success' | 'failureKind'>
): boolean {
    if (result.success) {
        return false;
    }
    if (result.failureKind === 'endpointUnreachable') {
        return true;
    }
    return false;
}

export function isProxyEndpointReachable(
    result: Pick<TestResult, 'success' | 'failureKind'>
): boolean {
    return result.success === true || !isProxyEndpointUnreachable(result);
}

export function buildConnectionTestObservation(
    result?: Pick<TestResult, 'failureKind' | 'proxyEndpointOk' | 'canaryHost' | 'testUrls' | 'errors'>
): { canaryHost?: string; failureKind?: ProxyTestFailureKind; proxyEndpointOk?: boolean } | undefined {
    if (!result) {
        return undefined;
    }

    return {
        canaryHost: result.canaryHost ?? extractCanaryHost(result.errors ?? [], result.testUrls ?? []),
        failureKind: result.failureKind,
        proxyEndpointOk: result.proxyEndpointOk
    };
}

function pickAggregateKind(kinds: readonly ProxyTestFailureKind[]): ProxyTestFailureKind {
    for (const candidate of AGGREGATE_KIND_PRIORITY) {
        if (kinds.includes(candidate)) {
            return candidate;
        }
    }
    return 'unknown';
}

function extractCanaryHost(
    errors: readonly TestUrlError[],
    testUrls: readonly string[]
): string | undefined {
    const candidates = [
        ...errors.map(error => error.url),
        ...testUrls
    ];

    for (const candidate of candidates) {
        const host = hostnameOf(candidate);
        if (host) {
            return host;
        }
    }
    return undefined;
}

function hostnameOf(value: string | undefined): string | undefined {
    if (!value || value === 'Proxy test' || value === 'All tests') {
        return undefined;
    }
    try {
        return new URL(value).hostname || undefined;
    } catch {
        return undefined;
    }
}
