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
