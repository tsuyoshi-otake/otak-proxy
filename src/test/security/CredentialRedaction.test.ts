import * as assert from 'assert';
import { ProxySecretRedactor } from '../../security/ProxySecretRedactor';
import { InputSanitizer } from '../../validation/InputSanitizer';

/**
 * Regression tests for credential leak paths found in the v3 post-release review.
 *
 * ProxySecretRedactor redacts strings that end up in diagnostics evidence and
 * notifications; InputSanitizer backs Logger. Both must handle credentials that
 * do not fit the happy-path "scheme://user:pass@host" shape:
 * - passwords containing an unencoded "@"
 * - scheme-less "user:pass@host:port" values (as returned by git/npm config)
 */
suite('Credential redaction hardening', () => {
    const redactor = new ProxySecretRedactor();
    const sanitizer = new InputSanitizer();

    suite('ProxySecretRedactor.redactString', () => {
        test('redacts the full credential when the password contains an unencoded @', () => {
            const result = redactor.redactString('http://user:p@ss@host:8080');
            assert.ok(!result.includes('ss@host'), `password tail must not leak: ${result}`);
            assert.strictEqual(result, 'http://<credentials>@host:8080');
        });

        test('redacts scheme-less user:pass@host credentials', () => {
            const result = redactor.redactString('proxy set to user:secret@10.0.0.1:3128 in npm config');
            assert.ok(!result.includes('secret'), `password must not leak: ${result}`);
            assert.ok(result.includes('<credentials>@10.0.0.1:3128'), `host must stay visible: ${result}`);
        });

        test('still redacts the ordinary scheme://user:pass@host shape', () => {
            assert.strictEqual(
                redactor.redactString('http://user:secret@host:8080'),
                'http://<credentials>@host:8080'
            );
        });

        test('redacts credentials with IPv6 hosts', () => {
            const result = redactor.redactString('http://user:secret@[::1]:8080');
            assert.ok(!result.includes('secret'), `password must not leak: ${result}`);
        });

        test('leaves credential-free URLs and prose untouched', () => {
            assert.strictEqual(
                redactor.redactString('http://proxy.example.com:8080'),
                'http://proxy.example.com:8080'
            );
            assert.strictEqual(
                redactor.redactString('git config returned nothing for http.proxy'),
                'git config returned nothing for http.proxy'
            );
        });

        test('does not redact plain email addresses (no password part)', () => {
            assert.strictEqual(
                redactor.redactString('contact admin@example.com for access'),
                'contact admin@example.com for access'
            );
        });
    });

    suite('InputSanitizer.maskPassword', () => {
        test('masks the password in scheme-less user:pass@host values', () => {
            const result = sanitizer.maskPassword('user:secret@10.0.0.1:3128');
            assert.ok(!result.includes('secret'), `password must not leak: ${result}`);
            assert.ok(result.includes('****'), `password must be masked: ${result}`);
        });

        test('keeps masking the ordinary URL shape', () => {
            assert.strictEqual(
                sanitizer.maskPassword('http://user:pass@proxy.com:8080'),
                'http://user:****@proxy.com:8080/'
            );
        });
    });
});
