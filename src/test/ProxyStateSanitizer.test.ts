import * as assert from 'assert';
import { ProxyMode, ProxyState } from '../core/types';
import {
    sanitizeProxyStateForPersistence,
    sanitizeProxyTestResultForPersistence
} from '../utils/ProxyStateSanitizer';

suite('ProxyStateSanitizer security tests', () => {
    const token = 'ghp_USERNAME_ONLY_TOKEN_123';
    const credentialUrl = `http://${token}@proxy.example.com:8080`;

    test('redacts username-only credentials from persisted state URLs and arbitrary messages', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            manualProxyUrl: credentialUrl,
            autoProxyUrl: credentialUrl,
            lastSystemProxyUrl: credentialUrl,
            fallbackProxyUrl: credentialUrl,
            lastError: `apply failed through ${credentialUrl}`,
            lastTestResult: {
                success: false,
                proxyUrl: credentialUrl,
                testUrls: [credentialUrl],
                errors: [{ url: credentialUrl, message: `request failed through ${credentialUrl}` }]
            }
        };

        const serialized = JSON.stringify(sanitizeProxyStateForPersistence(state));
        assert.ok(!serialized.includes(token), `token leaked from persisted state: ${serialized}`);
        assert.ok(serialized.includes('<credentials>@'), 'arbitrary text should use the strict redactor');
        assert.ok(serialized.includes('"requiresAuth":true'), 'auth-required metadata must survive sanitization');
    });

    test('preserves requiresAuth without writing userinfo into the persisted payload', () => {
        const sanitized = sanitizeProxyStateForPersistence({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://user:s3cret@proxy.example.com:8080',
            requiresAuth: true
        });

        assert.strictEqual(sanitized.autoProxyUrl, 'http://proxy.example.com:8080/');
        assert.strictEqual(sanitized.requiresAuth, true);
        assert.ok(!JSON.stringify(sanitized).includes('s3cret'));
    });

    test('redacts authorization headers and control characters from test errors', () => {
        const sanitized = sanitizeProxyTestResultForPersistence({
            success: false,
            testUrls: [],
            errors: [{
                url: 'https://example.com',
                message: `Authorization: Basic dXNlcjpzZWNyZXQ=\n${credentialUrl}\u001b[31m`
            }]
        });

        const message = sanitized!.errors[0].message;
        assert.ok(!message.includes(token));
        assert.ok(!message.includes('dXNlcjpzZWNyZXQ='));
        assert.ok(!message.includes('\u001b'));
        assert.ok(message.includes('<redacted>'));
    });
});
