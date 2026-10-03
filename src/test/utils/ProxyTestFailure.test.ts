import * as assert from 'assert';
import {
    buildConnectionTestObservation,
    classifyConnectError,
    classifyConnectStatus,
    isProxyEndpointReachable,
    isProxyEndpointUnreachable,
    proxyEndpointVerdict,
    summarizeFailedProxyTest
} from '../../utils/ProxyTestFailure';

suite('ProxyTestFailure', () => {
    test('classifies CONNECT status codes', () => {
        assert.strictEqual(classifyConnectStatus(407), 'authRequired');
        assert.strictEqual(classifyConnectStatus(403), 'destinationForbidden');
        assert.strictEqual(classifyConnectStatus(502), 'connectRejected');
        assert.strictEqual(classifyConnectStatus(503), 'connectRejected');
        assert.strictEqual(classifyConnectStatus(400), 'unknown');
    });

    test('classifies socket errors without treating timeout as unreachable', () => {
        const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
        const missing = Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND' });
        assert.strictEqual(classifyConnectError(refused), 'endpointUnreachable');
        assert.strictEqual(classifyConnectError(missing), 'dns');
        assert.strictEqual(classifyConnectError('Connection timeout (3000ms)'), 'timeout');
    });

    test('aggregates mixed canary failures toward proxy-alive kinds', () => {
        const summary = summarizeFailedProxyTest([
            { url: 'https://www.github.com', message: 'Proxy CONNECT failed with status 403', failureKind: 'destinationForbidden' },
            { url: 'https://www.google.com', message: 'Connection timeout (3000ms)', failureKind: 'timeout' }
        ], ['https://www.github.com', 'https://www.google.com']);

        assert.strictEqual(summary.failureKind, 'destinationForbidden');
        assert.strictEqual(summary.proxyEndpointOk, true);
        assert.strictEqual(summary.canaryHost, 'www.github.com');
        assert.strictEqual(isProxyEndpointUnreachable({ success: false, failureKind: summary.failureKind }), false);
    });

    test('clears only for endpointUnreachable', () => {
        assert.strictEqual(isProxyEndpointUnreachable({ success: false, failureKind: 'endpointUnreachable' }), true);
        assert.strictEqual(isProxyEndpointUnreachable({ success: false, failureKind: 'authRequired' }), false);
        assert.strictEqual(isProxyEndpointUnreachable({ success: false }), false);
        assert.strictEqual(isProxyEndpointUnreachable({ success: true, failureKind: 'endpointUnreachable' }), false);
        assert.strictEqual(isProxyEndpointReachable({ success: false, failureKind: 'authRequired' }), true);
        assert.strictEqual(isProxyEndpointReachable({ success: false, failureKind: 'endpointUnreachable' }), false);
    });

    test('endpoint verdict needs proof either way (#97)', () => {
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'endpointUnreachable' }), 'unreachable');

        assert.strictEqual(proxyEndpointVerdict({ success: true }), 'alive');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'authRequired', proxyEndpointOk: true }), 'alive');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'connectRejected', proxyEndpointOk: true }), 'alive');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'timeout', proxyConnected: true }), 'alive');

        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'timeout' }), 'unknown');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'dns' }), 'unknown');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'protocol', proxyConnected: false }), 'unknown');
        assert.strictEqual(proxyEndpointVerdict({ success: false, failureKind: 'unknown', proxyEndpointOk: false }), 'unknown');
        assert.strictEqual(proxyEndpointVerdict({ success: false }), 'unknown');
    });

    test('one attempt that reached the proxy outweighs a refused one (#97)', () => {
        const summary = summarizeFailedProxyTest([
            { url: 'https://www.github.com', message: 'connect ECONNREFUSED 127.0.0.1:9', failureKind: 'endpointUnreachable' },
            { url: 'https://www.google.com', message: 'Connection timeout (3000ms)', failureKind: 'timeout' }
        ], ['https://www.github.com', 'https://www.google.com']);

        assert.strictEqual(summary.failureKind, 'timeout');
        assert.strictEqual(proxyEndpointVerdict({ success: false, ...summary, proxyConnected: true }), 'alive');
        assert.strictEqual(proxyEndpointVerdict({ success: false, ...summary }), 'unknown');
    });

    test('observation exposes canaryHost, failureKind, and proxyEndpointOk without secrets', () => {
        const observation = buildConnectionTestObservation({
            failureKind: 'authRequired',
            proxyEndpointOk: true,
            canaryHost: 'www.github.com',
            testUrls: ['https://www.github.com'],
            errors: [{ url: 'https://www.github.com', message: 'Proxy CONNECT failed with status 407' }]
        });

        assert.deepStrictEqual(observation, {
            canaryHost: 'www.github.com',
            failureKind: 'authRequired',
            proxyEndpointOk: true
        });
        assert.ok(!JSON.stringify(observation).includes('@'));
    });
});
