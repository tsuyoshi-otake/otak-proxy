import * as assert from 'assert';
import { buildDetectedProxyValue, isPerSchemeProxy } from '../config/DetectedProxyValue';
import { parseWindowsProxyServer } from '../config/PlatformProxyDetection';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { evaluateTargetCapabilities, splitCapabilityIssues } from '../core/ProxyTargetCapability';
import { EnvMocker } from './crossPlatformMockers';

const HTTP_A = 'http://proxy-a.example.com:8080';
const HTTPS_B = 'http://proxy-b.example.com:8443';

suite('DetectedProxyValue #56 — do not collapse HTTP=A HTTPS=B', () => {
    test('keeps both environment URLs and marks perSchemeProxy', () => {
        const detected = buildDetectedProxyValue({
            http: HTTP_A,
            https: HTTPS_B,
            source: 'environment'
        });

        assert.strictEqual(detected.kind, 'perSchemeProxy');
        assert.strictEqual(detected.httpUrl, HTTP_A);
        assert.strictEqual(detected.httpsUrl, HTTPS_B);
        assert.ok(isPerSchemeProxy(detected.kind, detected.httpUrl, detected.httpsUrl));
        assert.notStrictEqual(detected.httpUrl, detected.httpsUrl);
    });

    test('same HTTP and HTTPS stays singleProxy', () => {
        const detected = buildDetectedProxyValue({
            http: HTTP_A,
            https: HTTP_A,
            source: 'environment'
        });

        assert.strictEqual(detected.kind, 'singleProxy');
        assert.strictEqual(detected.proxyUrl, HTTP_A);
        assert.strictEqual(detected.httpUrl, HTTP_A);
        assert.strictEqual(detected.httpsUrl, HTTP_A);
    });

    test('HTTPS-only is singleProxy and does not invent an HTTP peer', () => {
        const detected = buildDetectedProxyValue({
            https: HTTPS_B,
            source: 'windows'
        });

        assert.strictEqual(detected.kind, 'singleProxy');
        assert.strictEqual(detected.proxyUrl, HTTPS_B);
        assert.strictEqual(detected.httpsUrl, HTTPS_B);
        assert.ok(!isPerSchemeProxy(detected.kind, detected.httpUrl, detected.httpsUrl));
    });

    test('preserves detected bypass without treating it as applied', () => {
        const detected = buildDetectedProxyValue({
            http: HTTP_A,
            https: HTTPS_B,
            bypass: 'localhost;127.0.0.1',
            source: 'windows'
        });

        assert.strictEqual(detected.bypass, 'localhost;127.0.0.1');
        const bypass = evaluateTargetCapabilities(detected).find(item => item.targetId === 'bypass');
        assert.ok(bypass);
        assert.strictEqual(bypass.representability, 'notRepresentable');
        assert.strictEqual(bypass.issue?.id, 'system.bypass.notApplied');
        assert.strictEqual(bypass.issue?.evidence.forwarded, false);
    });
});

suite('parseWindowsProxyServer #56', () => {
    test('split http=A https=B keeps both URLs', () => {
        const parsed = parseWindowsProxyServer('http=proxy-a.example.com:8080;https=proxy-b.example.com:8443');
        assert.strictEqual(parsed.http, HTTP_A);
        assert.strictEqual(parsed.https, HTTPS_B);
    });

    test('https-only keeps the HTTPS endpoint', () => {
        const parsed = parseWindowsProxyServer('https=proxy-b.example.com:8443');
        assert.strictEqual(parsed.http, undefined);
        assert.strictEqual(parsed.https, HTTPS_B);
    });

    test('simple host:port is a single proxy for both schemes', () => {
        const parsed = parseWindowsProxyServer('proxy.example.com:8080');
        assert.strictEqual(parsed.http, 'http://proxy.example.com:8080');
        assert.strictEqual(parsed.https, 'http://proxy.example.com:8080');
    });
});

suite('SystemProxyDetector environment #56', () => {
    let envMocker: EnvMocker;

    setup(() => {
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    test('HTTP_PROXY≠HTTPS_PROXY is not collapsed to HTTP only', async () => {
        envMocker.mockEnv({
            HTTP_PROXY: HTTP_A,
            HTTPS_PROXY: HTTPS_B,
            http_proxy: HTTP_A,
            https_proxy: HTTPS_B,
            NO_PROXY: ''
        });

        const detector = new SystemProxyDetector(['environment']);
        const detected = await detector.detectSystemProxyWithSource();

        assert.strictEqual(detected.source, 'environment');
        assert.strictEqual(detected.kind, 'perSchemeProxy');
        assert.strictEqual(detected.httpUrl, HTTP_A);
        assert.strictEqual(detected.httpsUrl, HTTPS_B);
        assert.notStrictEqual(detected.proxyUrl, detected.httpsUrl);
    });
});

suite('ProxyTargetCapability #56', () => {
    const request = {
        kind: 'perSchemeProxy' as const,
        httpUrl: HTTP_A,
        httpsUrl: HTTPS_B,
        source: 'environment'
    };

    test('npm and terminal can represent split routing', () => {
        const byTarget = Object.fromEntries(
            evaluateTargetCapabilities(request).map(item => [item.targetId, item])
        );

        assert.strictEqual(byTarget.npm.representability, 'representable');
        assert.strictEqual(byTarget.npm.capability, 'supported');
        assert.ok(!byTarget.npm.issue);
        assert.strictEqual(byTarget.terminalEnv.representability, 'representable');
        assert.ok(!byTarget.terminalEnv.issue);
    });

    test('Git and VS Code are lossy and do not pretend one URL is complete', () => {
        const issues = splitCapabilityIssues(request);
        const git = issues.find(issue => issue.id === 'git.splitProxy.notRepresentable');
        const vscode = issues.find(issue => issue.id === 'vscode.splitProxy.notRepresentable');

        assert.ok(git);
        assert.strictEqual(git.category, 'capabilityUnavailable');
        assert.strictEqual(git.capability, 'unsupported');
        assert.strictEqual(git.evidence.routingKey, 'http.proxy');
        assert.match(String(git.evidence.gitRouting), /http\.proxy carries HTTP and HTTPS remotes/);
        assert.strictEqual(git.evidence.httpUrl, `${HTTP_A}/`);
        assert.strictEqual(git.evidence.httpsUrl, `${HTTPS_B}/`);

        assert.ok(vscode);
        assert.strictEqual(vscode.targetId, 'vscode.http.proxy');
        assert.strictEqual(vscode.evidence.representability, 'partiallyRepresentable');
    });

    test('redacts credentials in capability evidence', () => {
        const issues = splitCapabilityIssues({
            kind: 'perSchemeProxy',
            httpUrl: 'http://alice:s3cr3t@proxy-a.example.com:8080',
            httpsUrl: 'http://bob:p4ss@proxy-b.example.com:8443',
            source: 'environment'
        });
        const serialized = JSON.stringify(issues);
        assert.ok(!serialized.includes('s3cr3t'));
        assert.ok(!serialized.includes('p4ss'));
        assert.ok(!serialized.includes('alice'));
        assert.ok(!serialized.includes('bob'));
    });
});
