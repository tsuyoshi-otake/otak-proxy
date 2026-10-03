import * as assert from 'assert';
import * as fc from 'fast-check';
import { readTopLevelNpmrcString } from '../config/NpmUserConfigValue';
import { npmIniSafe } from './fakeConfigStores';
import { getPropertyTestRuns } from './helpers';

suite('readTopLevelNpmrcString (#85)', () => {
    const read = (text: string) => readTopLevelNpmrcString(text, 'proxy');

    test('reads a plain value written by npm config set', () => {
        assert.strictEqual(read('proxy=http://alice:s3cret@proxy.example.com:8080\n'), 'http://alice:s3cret@proxy.example.com:8080');
    });

    test('unescapes \\; and \\# and stops at an unescaped ; or #', () => {
        assert.strictEqual(read('proxy=http://carol:a\\;b\\#c@proxy.example.com:8080\n'), 'http://carol:a;b#c@proxy.example.com:8080');
        assert.strictEqual(read('proxy=http://proxy.example.com:8080 ; trailing comment\n'), 'http://proxy.example.com:8080');
        assert.strictEqual(read('proxy=http://proxy.example.com:8080#note\n'), 'http://proxy.example.com:8080');
    });

    test('keeps any other backslash escape as written', () => {
        assert.strictEqual(read('proxy=http://u:a\\b@proxy.example.com\n'), 'http://u:a\\b@proxy.example.com');
    });

    test('JSON-decodes a quoted value, as npm writes values containing =', () => {
        assert.strictEqual(read('proxy="http://dave:x%3By=z@proxy.example.com:8080"\n'), 'http://dave:x%3By=z@proxy.example.com:8080');
        assert.strictEqual(read('proxy=\'http://e:f@proxy.example.com\'\n'), 'http://e:f@proxy.example.com');
    });

    test('trims around the key, the = and the value, and tolerates CRLF and a BOM', () => {
        const bom = String.fromCodePoint(0xFEFF);
        assert.strictEqual(read(bom + '  proxy  =  http://a:b@proxy.example.com  \r\nhttps-proxy=x\r\n'), 'http://a:b@proxy.example.com');
    });

    test('skips comment lines and lets the last assignment win', () => {
        assert.strictEqual(read('; proxy=http://old:1@a.example.com\nproxy=http://a:1@a.example.com\n# c\nproxy=http://b:2@b.example.com\n'), 'http://b:2@b.example.com');
    });

    test('ignores keys inside sections and other keys with a matching prefix', () => {
        assert.strictEqual(read('proxy=http://a:b@top.example.com\n[other]\nproxy=http://x:y@nested.example.com\n'), 'http://a:b@top.example.com');
        assert.strictEqual(read('[other]\nproxy=http://x:y@nested.example.com\n'), null);
        assert.strictEqual(read('https-proxy=http://a:b@proxy.example.com\nproxyx=1\n'), null);
    });

    test('returns null for values npm would not load as this exact string', () => {
        assert.strictEqual(read(''), null, 'absent');
        assert.strictEqual(read('proxy\n'), null, 'bare flag loads as true');
        assert.strictEqual(read('proxy=true\n'), null);
        assert.strictEqual(read('proxy=null\n'), null);
        assert.strictEqual(read('proxy=\'123\'\n'), null, 'non-string JSON');
        assert.strictEqual(read('proxy=http://${PROXY_USER}:p@proxy.example.com\n'), null, 'npm expands ${VAR}');
        assert.strictEqual(read('proxy=http://a:b@proxy.example.com\nproxy[]=http://c:d@proxy.example.com\n'), null, 'array');
        assert.strictEqual(read('proxy=http://a:b@proxy.example.com\n[proxy]\nx=1\n'), null, 'section named like the key');
        assert.strictEqual(read('proxy=http://a:b@proxy.example.com\n[proxy.sub]\nx=1\n'), null, 'dotted section replaces the value');
    });

    test('property: reads back any credentialed proxy URL in the form npm writes it', function() {
        // npm's ini writer does not escape backslashes, so values containing one
        // do not round-trip through npm itself; ${ is expanded by npm on load.
        const passwordChar = fc.constantFrom(...'abcXYZ019%;#="\' -_.~!*'.split(''));
        fc.assert(
            fc.property(
                fc.array(passwordChar, { minLength: 1, maxLength: 24 }).map(chars => chars.join('')),
                fc.constantFrom('proxy', 'https-proxy'),
                (password, key) => {
                    const value = `http://user:${password}@proxy.example.com:8080`;
                    const text = `https-proxy=http://other.example.com\n${key}=${npmIniSafe(value)}\n`;
                    assert.strictEqual(readTopLevelNpmrcString(text, key), value);
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});
