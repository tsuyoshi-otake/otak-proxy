/**
 * Control characters in a proxy URL (#130).
 *
 * The WHATWG URL parser strips C0 controls from both ends of its input and
 * removes tab, LF and CR everywhere. A URL that carries one is therefore
 * parsed as a different string than the one the validator checked.
 */
import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { tryCanonicalizeProxyUrl } from '../utils/ProxyUrlUtils';
import { hasProxyCredentials } from '../utils/ProxyStateSanitizer';

/** C0 controls and DEL, built from code points so this file holds none. */
const CONTROL_CODES = [...Array.from({ length: 0x20 }, (_unused, code) => code), 0x7f];
const controlName = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

const BACKSLASH_LOGIN = 'http://DOMAIN\\alice:s3cret@proxy:8080';
const PLAIN = 'http://proxy.example.com:8080';
const WITH_CREDENTIALS = 'http://alice:s3cret@proxy.example.com:8080';

/**
 * True when the text between the scheme and the last `@` names a user or a
 * password. `http://@host` and `http://:@host` carry neither.
 */
function hasRawUserinfo(url: string): boolean {
    const authority = url.replace(/^[a-z]+:\/\//i, '');
    const at = authority.lastIndexOf('@');
    if (at < 0) {
        return false;
    }
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(':');
    const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
    const password = colon < 0 ? '' : userinfo.slice(colon + 1);
    return user !== '' || password !== '';
}

suite('Proxy URL control characters (#130)', () => {
    const validator = new ProxyUrlValidator();

    test('the backslash login is rejected without a control character', () => {
        assert.strictEqual(validator.validate(BACKSLASH_LOGIN).isValid, false);
    });

    for (const code of CONTROL_CODES) {
        const control = String.fromCharCode(code);

        test(`${controlName(code)} in front of a backslash login does not get it accepted`, () => {
            const result = validator.validate(control + BACKSLASH_LOGIN);
            assert.strictEqual(result.isValid, false);
            assert.strictEqual(result.normalizedUrl, undefined);
            assert.strictEqual(tryCanonicalizeProxyUrl(control + BACKSLASH_LOGIN), undefined);
        });

        test(`${controlName(code)} is rejected in front of, inside and behind a valid URL`, () => {
            const inUserinfo = WITH_CREDENTIALS.replace('s3cret', `s3${control}cret`);
            const inHost = PLAIN.replace('proxy.', `pro${control}xy.`);
            for (const url of [control + PLAIN, PLAIN + control, inUserinfo, inHost, control + WITH_CREDENTIALS]) {
                assert.strictEqual(
                    validator.validate(url).isValid,
                    false,
                    `accepted ${JSON.stringify(url)}`
                );
            }
        });
    }

    test('surrounding ASCII spaces are still trimmed', () => {
        const result = validator.validate(`  ${PLAIN}  `);
        assert.strictEqual(result.isValid, true);
        assert.strictEqual(result.normalizedUrl, PLAIN);
    });

    test('an accepted URL holds no control character and is read with its credentials', () => {
        const fragment = fc.constantFrom(
            'http://', 'HTTP://', 'https://', 'DOMAIN\\', 'alice', ':', 's3cret', '@', 'proxy', '.example.com',
            ':8080', '/', ' ', '\\', '%41', '[::1]',
            ...CONTROL_CODES.map(code => String.fromCharCode(code))
        );
        fc.assert(
            fc.property(fc.array(fragment, { minLength: 1, maxLength: 9 }), parts => {
                const url = parts.join('');
                const result = validator.validate(url);
                if (!result.isValid) {
                    return;
                }
                const accepted = result.normalizedUrl ?? '';
                assert.ok(
                    !CONTROL_CODES.some(code => accepted.includes(String.fromCharCode(code))),
                    `accepted ${JSON.stringify(url)}`
                );
                // What the validator saw as userinfo is what the credential
                // split sees: a password never rides along unrecognized.
                assert.strictEqual(
                    hasProxyCredentials(accepted),
                    hasRawUserinfo(accepted),
                    `credentials of ${JSON.stringify(url)}`
                );
            }),
            {
                numRuns: 2000,
                examples: [
                    [['\t', 'http://', 'DOMAIN\\', 'alice', ':', 's3cret', '@', 'proxy', ':8080']],
                    // An empty userinfo is no credential (CI counterexample, v3.2.18).
                    [['http://', '@', '[::1]']],
                    [['http://', ':', '@', 'proxy']],
                    [['http://', ':', 's3cret', '@', 'proxy']],
                    [['http://', 'alice', ':', '@', 'proxy']]
                ]
            }
        );
    });
});
