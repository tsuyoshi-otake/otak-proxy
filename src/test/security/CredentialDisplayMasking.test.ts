import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { InputSanitizer } from '../../validation/InputSanitizer';
import { ProxySecretRedactor, maskLooseCredentials } from '../../security/ProxySecretRedactor';
import { GitConfigManager } from '../../config/GitConfigManager';
import { ErrorAggregator } from '../../errors/ErrorAggregator';
import { saveProxyConfigResults } from '../../core/ProxyConfigStateTracker';
import { getStatusBarDisplay } from '../../ui/StatusBarDisplay';
import { buildStatusBarTooltip } from '../../ui/StatusBarTooltip';
import { I18nManager } from '../../i18n/I18nManager';
import { ProxyMode, ProxyState } from '../../core/types';
import type { ProxyStateManager } from '../../core/ProxyStateManager';
import { warnOnInvalidConfiguredProxyUrl } from '../../extension';
import { Logger } from '../../utils/Logger';
import { getPropertyTestRuns } from '../helpers';

/**
 * Regression tests for #108: passwords leaking into notifications, the status
 * bar tooltip, logs, and the Configure Manual Proxy input box.
 *
 * The text masker behind InputSanitizer.maskPassword and ProxySecretRedactor
 * must catch credentials in every position the old single-shot regexes missed:
 * second and later occurrences, credentials after "/", ":" or "@" without
 * whitespace, and "DOMAIN\user:pass@host" authorities that WHATWG rewrites
 * into the URL path.
 */
suite('Credential display masking (#108)', () => {
    const sanitizer = new InputSanitizer();

    suite('maskPassword text fallback', () => {
        test('masks every credential occurrence, not just the first', () => {
            const masked = sanitizer.maskPassword(
                'first http://u1:pw11111@h1 then http://u2:pw22222@h2'
            );
            assert.ok(!masked.includes('pw11111'), masked);
            assert.ok(!masked.includes('pw22222'), masked);
        });

        test('masks credentials right after "/", ":", "@", "(" and quotes', () => {
            for (const input of [
                'x/aa:s3cr3t@b',
                'x:aa:s3cr3t@b',
                'x@aa:s3cr3t@b',
                'x/("aa:s3cr3t@b")',
                'x=aa:s3cr3t@b;y'
            ]) {
                const masked = sanitizer.maskPassword(input);
                assert.ok(!masked.includes('s3cr3t'), `${input} -> ${masked}`);
            }
        });

        test('masks DOMAIN\\user credentials with and without a scheme', () => {
            for (const input of [
                'DOMAIN\\user:s3cr3t@proxy:8080',
                'prefix DOMAIN\\user:s3cr3t@proxy:8080 suffix',
                'http://DOMAIN\\user:s3cr3t@proxy:8080',
                'DOMAIN%5Cuser:s3cr3t@proxy:8080',
                'http://DOMAIN%5Cuser:s3cr3t@proxy:8080'
            ]) {
                const masked = sanitizer.maskPassword(input);
                assert.ok(!masked.includes('s3cr3t'), `${input} -> ${masked}`);
            }
        });

        test('leaves plain email addresses and credential-free URLs unchanged', () => {
            assert.strictEqual(
                sanitizer.maskPassword('contact admin@example.com for access'),
                'contact admin@example.com for access'
            );
        });

        test('keeps the single-URL display format pinned by the UI', () => {
            assert.strictEqual(
                sanitizer.maskPassword('http://user:pass@proxy:8080'),
                'http://user:****@proxy:8080/'
            );
            const masked = sanitizer.maskPassword('user:s3cr3t@10.0.0.1:3128');
            assert.ok(!masked.includes('s3cr3t'), masked);
            assert.ok(masked.includes('****'), masked);
        });
    });

    suite('maskPassword property', () => {
        test('embedded passwords never survive masking', () => {
            // Noise uses no "p" or "w", so a generated "pw..." password can
            // never appear in the padding by chance.
            const alphabet = 'abcdefghijklmnoqrstuvxyz0123456789 '.split('');
            fc.assert(
                fc.property(
                    fc.array(
                        fc.record({
                            user: fc.stringMatching(/^usr[a-z0-9]{3,8}$/),
                            pass: fc.stringMatching(/^pw[a-z0-9]{6,12}$/),
                            slashPass: fc.stringMatching(/^pw[a-z0-9]{3,6}[/?#]pw[a-z0-9]{3,6}$/),
                            leadPass: fc.stringMatching(/^[/?#\\]pw[a-z0-9]{3,6}$/),
                            host: fc.stringMatching(/^h[a-z0-9]{2,10}\.example$/),
                            shape: fc.constantFrom('url', 'bare', 'path', 'domain', 'urlSlash', 'urlLeadingSeparator')
                        }),
                        { minLength: 1, maxLength: 3 }
                    ),
                    fc.array(fc.constantFrom(...alphabet), { minLength: 0, maxLength: 30 }).map(c => c.join('')),
                    (credentials, noise) => {
                        const embedded = credentials.map(c => {
                            switch (c.shape) {
                                case 'url': return `http://${c.user}:${c.pass}@${c.host}`;
                                case 'urlSlash': return `http://${c.user}:${c.slashPass}@${c.host}`;
                                case 'urlLeadingSeparator': return `http://${c.user}:${c.leadPass}@${c.host}`;
                                case 'path': return `pre/${c.user}:${c.pass}@${c.host}`;
                                case 'domain': return `D\\${c.user}:${c.pass}@${c.host}`;
                                default: return `${c.user}:${c.pass}@${c.host}`;
                            }
                        }).join(` ${noise} `);
                        const masked = sanitizer.maskPassword(embedded);
                        for (const c of credentials) {
                            if (c.shape === 'urlSlash') {
                                // The whole password run must be masked; neither
                                // the part before nor the part after the "/",
                                // "?" or "#" separator may survive.
                                const separatorIndex = c.slashPass.search(/[/?#]/);
                                const secondPart = c.slashPass.slice(separatorIndex + 1);
                                assert.ok(
                                    !masked.includes(c.slashPass),
                                    `password ${c.slashPass} leaked in "${embedded}" -> "${masked}"`
                                );
                                assert.ok(
                                    !masked.includes(secondPart),
                                    `password tail ${secondPart} leaked in "${embedded}" -> "${masked}"`
                                );
                            } else if (c.shape === 'urlLeadingSeparator') {
                                // The parser moves a leading "/", "?", "#" or
                                // "\" password into the path/query/fragment;
                                // the part after the separator must not survive.
                                assert.ok(
                                    !masked.includes(c.leadPass.slice(1)),
                                    `password tail ${c.leadPass.slice(1)} leaked in "${embedded}" -> "${masked}"`
                                );
                            } else {
                                assert.ok(
                                    !masked.includes(c.pass),
                                    `password ${c.pass} leaked in "${embedded}" -> "${masked}"`
                                );
                            }
                        }
                    }
                ),
                { numRuns: getPropertyTestRuns() }
            );
        });

        test('whitespace-containing passwords never survive masking', () => {
            // A raw space or tab in a password makes the validator reject the
            // URL, but the rejected value still reaches logs and messages.
            // The password alphabet is letters, digits, space, tab and
            // ":?#\%!$&'()*+,;=~._-" — it excludes "/", "@" and line breaks so a
            // generated password always stays inside alternative 3's run.
            // Whitespace may be leading, trailing or repeated; only at least
            // one space or tab and one other character is required.
            const redactor = new ProxySecretRedactor();
            const passAlphabet =
                'abcdefghijklmnopqrstuvwxyz0123456789 \t'.split('')
                    .concat(":?#\\%!$&'()*+,;=~._-".split(''));
            fc.assert(
                fc.property(
                    fc.record({
                        user: fc.stringMatching(/^usr[a-z0-9]{3,8}$/),
                        spacePass: fc.array(fc.constantFrom(...passAlphabet), { minLength: 2, maxLength: 12 })
                            .map(c => c.join(''))
                            .filter(p => /[ \t]/.test(p) && /[^ \t]/.test(p)),
                        host: fc.stringMatching(/^h[a-z0-9]{2,10}\.example$/)
                    }),
                    (c) => {
                        const url = `http://${c.user}:${c.spacePass}@${c.host}`;
                        assert.strictEqual(
                            sanitizer.maskPassword(`failed ${url}`),
                            `failed http://${c.user}:****@${c.host}`
                        );
                        // A "?", "#" or "\" ends the authority of a
                        // special-scheme URL, so the typed value does not
                        // parse with the password as userinfo and is shown as
                        // typed (no trailing "/").
                        const shownAsTyped = /[?#\\]/.test(c.spacePass);
                        assert.strictEqual(
                            sanitizer.maskPassword(url),
                            `http://${c.user}:****@${c.host}${shownAsTyped ? '' : '/'}`
                        );
                        assert.strictEqual(
                            redactor.redactString(`failed ${url}`),
                            `failed http://<credentials>@${c.host}`
                        );
                        assert.strictEqual(
                            redactor.redactString(url),
                            `http://<credentials>@${c.host}`
                        );
                    }
                ),
                { numRuns: getPropertyTestRuns() }
            );
        });
    });

    suite('passwords containing unencoded "/", "?" or "#" (PR #113 review)', () => {
        const redactor = new ProxySecretRedactor();

        // Pinned by the Codex review of PR #113: a password with a raw "/",
        // "?" or "#" makes new URL() reject the input or splits the authority
        // at that character, so both consumers of the shared credential
        // patterns must still mask the userinfo up to the last "@" of the run.
        const rows: Array<{ input: string; masked: string; redacted: string }> = [
            // The next four values do not parse with the password as userinfo
            // (the "/", "?" or "#" ends the authority), so they are shown as
            // typed — no trailing "/" like "http://user:pass@host:8080" gets.
            {
                input: 'http://user:pa/ss@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'Command failed: git config --global http.proxy http://user:pa/ss@host:8080',
                masked: 'Command failed: git config --global http.proxy http://user:****@host:8080',
                redacted: 'Command failed: git config --global http.proxy http://<credentials>@host:8080'
            },
            {
                input: 'http://user:12/ss@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'http://user:12?ss@host',
                masked: 'http://user:****@host',
                redacted: 'http://<credentials>@host'
            },
            {
                input: 'http://user:12#ss@host',
                masked: 'http://user:****@host',
                redacted: 'http://<credentials>@host'
            },
            // Rows that must keep today's output.
            {
                input: 'https://user:pass@registry.example.com/@scope/pkg',
                masked: 'https://user:****@registry.example.com/@scope/pkg',
                redacted: 'https://<credentials>@registry.example.com/@scope/pkg'
            },
            {
                input: 'http://user:p@ss@host',
                masked: 'http://user:****@host/',
                redacted: 'http://<credentials>@host'
            },
            {
                input: 'https://registry.npmjs.org/@types/node',
                masked: 'https://registry.npmjs.org/@types/node',
                redacted: 'https://registry.npmjs.org/@types/node'
            },
            // Accepted over-masking: a port followed by an "@" later in the same
            // whitespace-free token cannot be told apart from a password that
            // contains "/" (http://user:12/ss@host:8080), so the port run is
            // masked as userinfo, inside text and in a standalone valid URL
            // alike. Pinned so a later change is deliberate.
            {
                input: 'GET https://registry.example.com:8443/@scope/pkg failed',
                masked: 'GET https://registry.example.com:****@scope/pkg failed',
                redacted: 'GET https://<credentials>@scope/pkg failed'
            },
            {
                input: 'http://localhost:3000/@vite/client',
                masked: 'http://localhost:****@vite/client',
                redacted: 'http://<credentials>@vite/client'
            },
            // A password that starts with "/", "?", "#" or "\": the URL parser
            // reads "user:<sep>..." as host "user" with an empty port and moves
            // the password into the path, query or fragment, so the loose pass
            // on the value as typed masks it — and the value is shown as
            // typed, without the parser's trailing "/".
            {
                input: 'http://user:/abc@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'http://user:?abc@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'http://user:#abc@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'http://user:\\abc@host:8080',
                masked: 'http://user:****@host:8080',
                redacted: 'http://<credentials>@host:8080'
            },
            {
                input: 'https://user:/abc@host',
                masked: 'https://user:****@host',
                redacted: 'https://<credentials>@host'
            },
            {
                input: 'failed http://user:/abc@host:8080',
                masked: 'failed http://user:****@host:8080',
                redacted: 'failed http://<credentials>@host:8080'
            }
        ];

        test('maskPassword and redactString mask malformed absolute-URL userinfo', () => {
            const failures: string[] = [];
            for (const { input, masked, redacted } of rows) {
                const actualMasked = sanitizer.maskPassword(input);
                if (actualMasked !== masked) {
                    failures.push(
                        `maskPassword(${JSON.stringify(input)})\n  want: ${masked}\n  got:  ${actualMasked}`
                    );
                }
                const actualRedacted = redactor.redactString(input);
                if (actualRedacted !== redacted) {
                    failures.push(
                        `redactString(${JSON.stringify(input)})\n  want: ${redacted}\n  got:  ${actualRedacted}`
                    );
                }
            }
            assert.deepStrictEqual(failures, [], failures.join('\n'));
        });

        test('maskPassword masks the re-serialized text again', () => {
            // Pins the second maskCredentialOccurrences pass over the parsed
            // URL: the parser removes the tab inside the credential sitting in
            // the path, so "http://proxy/u:p\tass@h" serializes as
            // "http://proxy/u:pass@h" — a credential the raw-text pass cannot
            // see. redactString shows the value as "http://proxy/u:p\\tass@h";
            // that scheme-less residual is already listed and is not pinned.
            assert.strictEqual(
                sanitizer.maskPassword('http://proxy/u:p\tass@h'),
                'http://proxy/u:****@h'
            );
        });

        test('masking stays linear on credential-run input', () => {
            const inputs = [
                'x://a:b'.repeat(40000),
                'x://a:' + ' b'.repeat(70000),
                'x://a:b c '.repeat(14000)
            ];

            for (const input of inputs) {
                const maskStart = process.hrtime.bigint();
                sanitizer.maskPassword(input);
                const maskMs = Number(process.hrtime.bigint() - maskStart) / 1e6;

                const redactStart = process.hrtime.bigint();
                redactor.redactString(input);
                const redactMs = Number(process.hrtime.bigint() - redactStart) / 1e6;

                assert.ok(maskMs < 1000, `maskPassword took ${maskMs.toFixed(1)} ms on input length ${input.length}`);
                assert.ok(redactMs < 1000, `redactString took ${redactMs.toFixed(1)} ms on input length ${input.length}`);
            }
        });
    });

    suite('passwords containing whitespace (PR #113 review)', () => {
        const redactor = new ProxySecretRedactor();

        // Pinned by the Codex review of PR #113 (round 3): a password with a
        // raw space or tab makes the validator reject the URL, but the
        // rejected value still reaches logs and messages. Alternatives 1 and
        // 2 of the shared pattern stop at the whitespace, so a third
        // alternative consumes the userinfo up to the FIRST "@": a run that
        // may contain spaces would otherwise swallow the host whenever the
        // line later contains an e-mail address. The run excludes "/" (it
        // could then reach into a later URL's authority) and line breaks.
        const rows: Array<{ input: string; masked: string; redacted: string }> = [
            {
                input: 'failed http://user:pa ss@host:8080',
                masked: 'failed http://user:****@host:8080',
                redacted: 'failed http://<credentials>@host:8080'
            },
            {
                input: 'unable to access \'http://user:pa ss@host:8080/\'',
                masked: 'unable to access \'http://user:****@host:8080/\'',
                redacted: 'unable to access \'http://<credentials>@host:8080/\''
            },
            {
                input: 'GET http://user:pa\tss@host failed',
                masked: 'GET http://user:****@host failed',
                redacted: 'GET http://<credentials>@host failed'
            },
            // The loose display pass (pre-#108 semantics) masks from the
            // first "//x:" to the next "@", so this line loses the "a:1" URL
            // too — same as before #108.
            {
                input: 'http://a:1 then http://user:pa ss@host',
                masked: 'http://a:****@host',
                redacted: 'http://a:1 then http://<credentials>@host'
            },
            {
                input: 'error: http://user:pa ss@host:8080 and mail me@corp',
                masked: 'error: http://user:****@host:8080 and mail me@corp',
                redacted: 'error: http://<credentials>@host:8080 and mail me@corp'
            },
            // A standalone URL goes through the URL parser in maskPassword
            // first, which re-serializes it with a trailing "/"; the strict
            // redactor masks the raw text.
            {
                input: 'http://user:pa ss@host:8080',
                masked: 'http://user:****@host:8080/',
                redacted: 'http://<credentials>@host:8080'
            },
            // Rows where the strict redactor keeps today's output. The loose
            // display pass (pre-#108 semantics) still masks them: its
            // authority pass runs from "//proxy:" to the next "@" across "/",
            // whitespace and line breaks.
            {
                input: 'see http://proxy:8080/x and me@corp',
                masked: 'see http://proxy:****@corp',
                redacted: 'see http://proxy:8080/x and me@corp'
            },
            {
                input: 'see http://proxy:8080\nmail admin@corp',
                masked: 'see http://proxy:****@corp',
                redacted: 'see http://proxy:8080\\nmail admin@corp'
            },
            {
                input: 'see http://proxy failed: contact admin@corp',
                masked: 'see http://proxy failed:****@corp',
                redacted: 'see http://proxy failed: contact admin@corp'
            },
            // Accepted over-masking: a port followed, on the same line and
            // before any "/", by text that contains an "@" has the same shape
            // as a password with a space and cannot be told apart from it.
            // Pinned so a later change is deliberate.
            {
                input: 'see http://proxy:8080 is down, mail admin@corp',
                masked: 'see http://proxy:****@corp',
                redacted: 'see http://<credentials>@corp'
            }
        ];

        test('maskPassword and redactString mask whitespace-containing URL userinfo', () => {
            const failures: string[] = [];
            for (const { input, masked, redacted } of rows) {
                const actualMasked = sanitizer.maskPassword(input);
                if (actualMasked !== masked) {
                    failures.push(
                        `maskPassword(${JSON.stringify(input)})\n  want: ${masked}\n  got:  ${actualMasked}`
                    );
                }
                const actualRedacted = redactor.redactString(input);
                if (actualRedacted !== redacted) {
                    failures.push(
                        `redactString(${JSON.stringify(input)})\n  want: ${redacted}\n  got:  ${actualRedacted}`
                    );
                }
            }
            assert.deepStrictEqual(failures, [], failures.join('\n'));
        });
    });

    suite('maskPassword never masks less than the pre-#108 display masker (PR #113 review)', () => {
        const TAB = String.fromCharCode(9);
        const LF = String.fromCharCode(10);

        // Differential-fuzz findings against the pre-#108 masker: every row
        // only the pre-#108 masker's two text fallbacks masked is a
        // regression. maskPassword covers them via the loose pass on the
        // non-parsing / no-host / empty-port paths.
        const rows: Array<{ input: string; masked: string }> = [
            {
                input: 'http://user:pa ss/x@host:8080',
                masked: 'http://user:****@host:8080'
            },
            {
                input: 'err http://user:pa ss/x@host:8080 x',
                masked: 'err http://user:****@host:8080 x'
            },
            {
                input: `err http://user:pa${LF}ss@host x`,
                masked: 'err http://user:****@host x'
            },
            {
                input: `x=https://do/main:kk'SECRET@10.0.0.1:3128 x`,
                masked: `x=https://do/main:****@10.0.0.1:3128 x`
            },
            {
                input: `git: u:SEC'k#RET@host x`,
                masked: 'git: u:****@host x'
            },
            {
                input: `see //u:SEC${TAB}RET@host:8080/path mail a@b`,
                masked: 'see //u:****@host:8080/path mail a@b'
            },
            {
                input: '//u:pass word@host',
                masked: '//u:****@host'
            },
            {
                input: `err http://do/main:'kSECRET@host:8080'`,
                masked: `err http://do/main:****@host:8080'`
            },
            {
                input: `user:pa'ss@host`,
                masked: 'user:****@host'
            },
            // Accepted over-masking, as before #108: the authority pass runs from
            // "//proxy:" to the next "@" across the line break.
            {
                input: `connect http://proxy:8080/status failed${LF}mail admin@corp`,
                masked: 'connect http://proxy:****@corp'
            },
            // Empty-port authority with whitespace in the password (B2): the
            // parser moves the password into the path, so the loose pass on
            // the raw text has to cover it.
            {
                input: 'http://user:/pa ss@host:8080',
                masked: 'http://user:****@host:8080'
            },
            {
                input: 'HTTP://b:/= SECRET@host mail a@b',
                masked: 'HTTP://b:****@host mail a@b'
            },
            {
                input: `http://aa:${TAB}\\${LF}SECRET@host:8080 http://u2:p2@h2`,
                masked: 'http://aa:****@host:8080 http://u2:****@h2'
            },
            // Empty-port value without credentials: shown as typed, not in
            // the parser's form (accepted — display text only).
            {
                input: 'http://host:/path',
                masked: 'http://host:/path'
            },
            // A valid URL with ":" in the path and a later "@" is not a
            // credential and stays unchanged.
            {
                input: 'https://example.com/a:b/c@d',
                masked: 'https://example.com/a:b/c@d'
            }
        ];

        test('maskPassword masks the shapes only the pre-#108 text fallbacks covered', () => {
            const failures: string[] = [];
            for (const { input, masked } of rows) {
                const actual = sanitizer.maskPassword(input);
                if (actual !== masked) {
                    failures.push(
                        `maskPassword(${JSON.stringify(input)})\n  want: ${masked}\n  got:  ${actual}`
                    );
                }
            }
            assert.deepStrictEqual(failures, [], failures.join('\n'));
        });

        // Differential-fuzz findings against the pre-#108 masker (PR #113
        // review): token-like usernames that the pre-#108 masker masked
        // re-appeared. Rows 1-2: an empty password leaves a token-like
        // username, which the pre-#108 username-only rule masked (the
        // pre-#108 masker showed row 2 through its text fallback). Rows 3
        // and 8: a raw "@" before the ":" — the match ran past the userinfo
        // the parser reads, and the pre-#108 masker hid the part before the
        // first "@" (the pre-#108 masker showed "pass" in row 8). Rows 4-7:
        // the parser ends the authority before the pattern's last "@".
        // Row 9: the UPN display stays as before #108.
        // Row 10: the premasked parse keeps the typed parse's host. Rows
        // 11-12: the typed parse decides when the premask changes the host or
        // the username. "\" below is one backslash in the value.
        const tokenRows: Array<{ input: string; masked: string }> = [
            { input: 'http://ghp_SECRET:@proxy:8080', masked: 'http://****@proxy:8080/' },
            { input: 'err http://ghp_SECRET:@proxy:8080 x', masked: 'err http://****@proxy:8080 x' },
            { input: 'err http://TOKEN@proxy:8080,user@corp x', masked: 'err http://****@corp x' },
            { input: 'http://TOKEN@host:8080?a:b@c', masked: 'http://****@host:8080/?a:****@c' },
            { input: 'http://TOKEN:@h?a:b@host', masked: 'http://****@h/?a:****@host' },
            { input: 'http://TOKEN:@h?a:b@h', masked: 'http://****@h/?a:****@h' },
            { input: 'https://SECRET:@h\\a:b@proxy:8080', masked: 'https://****@h/a:****@proxy:8080' },
            { input: 'err http://john@corp.com:pass@proxy:8080 x', masked: 'err http://****@proxy:8080 x' },
            { input: 'http://john@corp.com:pass@proxy:8080', masked: 'http://john%40corp.com:****@proxy:8080/' },
            { input: 'http://DOMAIN\\user:pa\\ss@proxy:8080', masked: 'http://domain/user:****@proxy:8080' },
            { input: 'http://u:pw@h?x:y@z', masked: 'http://u:****@h/?x:****@z' },
            { input: 'http://TOKEN@h?x@y:z@h', masked: 'http://****@h/?x@y:****@h' }
        ];

        test('maskPassword masks token-like usernames that the pre-#108 masker masked', () => {
            const failures: string[] = [];
            for (const { input, masked } of tokenRows) {
                const actual = sanitizer.maskPassword(input);
                if (actual !== masked) {
                    failures.push(
                        `maskPassword(${JSON.stringify(input)})\n  want: ${masked}\n  got:  ${actual}`
                    );
                }
            }
            assert.deepStrictEqual(failures, [], failures.join('\n'));
        });

        test('token-like usernames never survive masking', () => {
            // A suffix with an "@" outside a path (' mail a@b') is left out on
            // purpose: the parser then reads the run up to that "@" as
            // userinfo and shows the username, as the pre-#108 masker did.
            const tokenMiddle = ["'", '-', '%', '.', '!', '=', '~', ';', ',', '(', '_', 'a', '0'];
            fc.assert(
                fc.property(
                    fc.record({
                        prefix: fc.constantFrom('', 'err ', 'x=', '"', "'", 'git: ', '(', 'a/', 'see '),
                        scheme: fc.constantFrom('http://', 'https://', 'socks5://', 'HTTP://'),
                        middle: fc.array(
                            fc.constantFrom(...tokenMiddle),
                            { minLength: 0, maxLength: 2 }
                        ).map(c => c.join('')),
                        tail: fc.constantFrom('', ':'),
                        host: fc.constantFrom('@proxy:8080', '@proxy', '@10.0.0.1:3128', '@proxy:8080/p', '@corp', '@[::1]:3128'),
                        suffix: fc.constantFrom('', ' x', '/p', `${LF}next`, '"', "'", ' http://u2:p2@h2', '/a@b')
                    }),
                    (c) => {
                        const input = `${c.prefix}${c.scheme}SEC${c.middle}RET${c.tail}${c.host}${c.suffix}`;
                        const masked = sanitizer.maskPassword(input);
                        assert.ok(
                            !masked.includes('SEC') && !masked.includes('RET'),
                            `marker leaked in maskPassword(${JSON.stringify(input)}) -> ${JSON.stringify(masked)}`
                        );
                    }
                ),
                { numRuns: getPropertyTestRuns() }
            );
        });

        test('authority-shape passwords never survive masking', () => {
            const middleChars = [' ', TAB, LF, '/', '?', '#', '\\', "'", '"', '=', ':', '%', 'a', '0'];
            fc.assert(
                fc.property(
                    fc.record({
                        prefix: fc.constantFrom('', 'err ', 'x=', "'", '(', 'a/'),
                        scheme: fc.constantFrom('http://', 'https://', 'HTTP://', 'socks5://', '//'),
                        user: fc.array(
                            fc.constantFrom('a', 'b', ' ', TAB, "'", '"', '=', '0', '_', '-'),
                            { minLength: 1, maxLength: 4 }
                        ).map(c => c.join('')),
                        middle: fc.array(
                            fc.constantFrom(...middleChars),
                            { minLength: 0, maxLength: 4 }
                        ).map(c => c.join('')),
                        passwordForm: fc.constantFrom('wrapped', 'leading'),
                        host: fc.constantFrom('@host:8080', '@host', '@10.0.0.1:3128', '@host:8080/path', '@[::1]:3128'),
                        suffix: fc.constantFrom('', ' x', '/p', ' mail a@b', `${LF}next line`, "'", ' http://u2:p2@h2')
                    }),
                    (c) => {
                        const password = c.passwordForm === 'wrapped'
                            ? `SEC${c.middle}RET`
                            : `${c.middle}SECRET`;
                        const input = `${c.prefix}${c.scheme}${c.user}:${password}${c.host}${c.suffix}`;
                        const masked = sanitizer.maskPassword(input);
                        assert.ok(
                            !masked.includes('SEC') && !masked.includes('RET'),
                            `marker leaked in maskPassword(${JSON.stringify(input)}) -> ${JSON.stringify(masked)}`
                        );
                    }
                ),
                { numRuns: getPropertyTestRuns() }
            );
        });

        test('scheme-less passwords never survive masking', () => {
            const middleChars = ["'", '"', '=', ':', '#', '?', '\\', 'a', '0'];
            fc.assert(
                fc.property(
                    fc.record({
                        boundary: fc.constantFrom('', 'cfg ', 'cfg='),
                        user: fc.array(
                            fc.constantFrom('u', 's', "'", '"', '=', '\\', '0', '_', '!', '.'),
                            { minLength: 1, maxLength: 4 }
                        ).map(c => c.join('')),
                        middle: fc.array(
                            fc.constantFrom(...middleChars),
                            { minLength: 0, maxLength: 4 }
                        ).map(c => c.join('')),
                        passwordForm: fc.constantFrom('wrapped', 'leading'),
                        suffix: fc.constantFrom('', ' x', `${LF}next`, ' mail a@b', "'")
                    }),
                    (c) => {
                        const password = c.passwordForm === 'wrapped'
                            ? `SEC${c.middle}RET`
                            : `${c.middle}SECRET`;
                        const input = `${c.boundary}${c.user}:${password}@host${c.suffix}`;
                        const masked = sanitizer.maskPassword(input);
                        assert.ok(
                            !masked.includes('SEC') && !masked.includes('RET'),
                            `marker leaked in maskPassword(${JSON.stringify(input)}) -> ${JSON.stringify(masked)}`
                        );
                    }
                ),
                { numRuns: getPropertyTestRuns() }
            );
        });

        test('maskLooseCredentials stays linear on adversarial input', () => {
            const inputs = [
                '//a:b'.repeat(28000),
                '//a'.repeat(46000),
                '//a@'.repeat(35000),
                '=a:b'.repeat(35000),
                '=a'.repeat(70000) + '@',
                'a='.repeat(70000) + ':@',
                '//:'.repeat(460000) + '@',
                '//:a'.repeat(345000) + '@',
                ' a@'.repeat(460000) + ':',
                '=a@'.repeat(460000) + ':'
            ];
            for (const input of inputs) {
                const start = process.hrtime.bigint();
                maskLooseCredentials(input, '****');
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                assert.ok(ms < 1000, `maskLooseCredentials took ${ms.toFixed(1)} ms on input length ${input.length}`);
            }
        });
    });

    suite('Git write failure error text', () => {
        const PASSWORD = 's3cr3t-p4ss';
        const URL = `http://user:${PASSWORD}@proxy.example:8080`;
        let tempDir: string;
        let savedGitConfigGlobal: string | undefined;

        setup(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-git-cred-'));
            savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
        });

        teardown(() => {
            if (savedGitConfigGlobal === undefined) {
                delete process.env.GIT_CONFIG_GLOBAL;
            } else {
                process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
            }
            if (tempDir) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        function useGitConfig(content: string): string {
            const gitconfig = path.join(tempDir, 'gitconfig');
            fs.writeFileSync(gitconfig, content);
            process.env.GIT_CONFIG_GLOBAL = gitconfig;
            return gitconfig;
        }

        function createTrackingWriter(): { writer: ProxyStateManager; committed: () => ProxyState } {
            let committed: ProxyState = { mode: ProxyMode.Off, revision: 0 };
            const writer = {
                getState: async () => committed,
                saveState: async (next: ProxyState) => { committed = next; },
                commitState: async (expectedRevision: number, next: ProxyState) => {
                    committed = { ...next, revision: expectedRevision + 1 };
                    return { kind: 'committed' as const, revision: expectedRevision + 1, state: committed };
                }
            } as unknown as ProxyStateManager;
            return { writer, committed: () => committed };
        }

        // The real display path: getStatusBarDisplay appends state.lastError
        // to statusText, and buildStatusBarTooltip renders it via appendText.
        function tooltipText(state: ProxyState): string {
            const i18n = I18nManager.getInstance();
            i18n.initialize('en');
            const display = getStatusBarDisplay(state, true, i18n, sanitizer);
            const tooltip = buildStatusBarTooltip({
                state,
                statusText: display.statusText,
                monitorState: null,
                lastCheck: null,
                i18n,
                sanitizer,
                registeredCommands: [],
                showUrl: true
            });
            return (tooltip as unknown as { value: string }).value;
        }

        async function assertEndToEndMasked(error: string | undefined, errorType: string): Promise<void> {
            assert.ok(error, 'expected an error message');
            assert.ok(!error.includes(PASSWORD), `returned error leaks the password: ${error}`);

            const aggregator = new ErrorAggregator();
            aggregator.addError('Git configuration', error, errorType);
            const aggregated = aggregator.formatErrors();
            assert.ok(!aggregated.includes(PASSWORD), `aggregated notification leaks: ${aggregated}`);

            const tracker = createTrackingWriter();
            await saveProxyConfigResults(
                tracker.writer,
                true,
                {
                    gitSuccess: false,
                    vscodeSuccess: false,
                    npmSuccess: false,
                    terminalEnvSuccess: false
                },
                aggregator
            );
            const committed = tracker.committed();
            const lastError = committed.lastError ?? '';
            assert.ok(lastError, 'expected lastError to be committed');
            assert.ok(!lastError.includes(PASSWORD), `in-memory lastError leaks: ${lastError}`);
            // Aggregated errors are multi-line; the tooltip needs real line
            // breaks, not an escaped "\n" from control-character redaction.
            assert.ok(lastError.includes('\n'), `lastError lost its line breaks: ${lastError}`);
            assert.ok(!lastError.includes('\\n'), `lastError has a literal backslash-n: ${lastError}`);

            const tooltip = tooltipText(committed);
            assert.ok(!tooltip.includes(PASSWORD), `tooltip leaks: ${tooltip}`);
            assert.ok(!tooltip.includes('\\n'), `tooltip shows a literal backslash-n: ${tooltip}`);
        }

        test('UNKNOWN error (broken config file) is masked at every consumer', async () => {
            useGitConfig('[http\n\tproxy = broken');
            const manager = new GitConfigManager();
            const result = await manager.setProxy(URL);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.errorType, 'UNKNOWN');
            await assertEndToEndMasked(result.error, 'UNKNOWN');
        });

        test('LOCKED error (existing .lock file) is masked at every consumer', async () => {
            const gitconfig = useGitConfig('[http]\n\tproxy = http://old.example:8080\n');
            // A live (fresh) lock file is not reclaimed as stale, so every
            // git write fails with "could not lock config file" -> LOCKED.
            fs.writeFileSync(`${gitconfig}.lock`, '');
            const manager = new GitConfigManager();
            const result = await manager.setProxy(URL);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.errorType, 'LOCKED');
            await assertEndToEndMasked(result.error, 'LOCKED');
        });
    });

    suite('ErrorAggregator masks at ingestion (#108)', () => {
        test('formatErrors and display parts carry no password from an unmasked multi-line error', () => {
            const aggregator = new ErrorAggregator();
            aggregator.addError(
                'npm configuration',
                'line one http://u1:pw-alpha@h1.example failed\n' +
                    'line two http://u2:pw-beta@h2.example failed\n' +
                    'line three user:pw-gamma@h3.example failed'
            );

            const formatted = aggregator.formatErrors();
            for (const password of ['pw-alpha', 'pw-beta', 'pw-gamma']) {
                assert.ok(!formatted.includes(password),
                    `formatErrors leaks ${password}: ${formatted}`);
            }
            // Notification text is multi-line; ingestion masking must not
            // collapse or escape the original line breaks. The break inside
            // the error text must be a real newline, not a literal "\n".
            assert.ok(formatted.includes('line one'), formatted);
            assert.ok(formatted.includes('line two'), formatted);
            assert.ok(formatted.includes('line three'), formatted);
            assert.match(formatted, /failed\r?\nline two/,
                `formatErrors must keep a real line break inside the error text: ${formatted}`);
            assert.ok(!formatted.includes('\\n'),
                `formatErrors shows a literal backslash-n: ${formatted}`);

            const parts = aggregator.getDisplayParts();
            for (const password of ['pw-alpha', 'pw-beta', 'pw-gamma']) {
                assert.ok(!parts.message.includes(password),
                    `display parts leak ${password}: ${parts.message}`);
                for (const suggestion of parts.suggestions) {
                    assert.ok(!suggestion.includes(password),
                        `suggestion leaks ${password}: ${suggestion}`);
                }
            }
            assert.match(parts.message, /failed\r?\nline two/,
                `display parts must keep a real line break inside the error text: ${parts.message}`);
            assert.ok(!parts.message.includes('\\n'),
                `display parts show a literal backslash-n: ${parts.message}`);
        });
    });

    suite('activation warning for an invalid otakProxy.proxyUrl (#108)', () => {
        type WarningConfig = Parameters<typeof warnOnInvalidConfiguredProxyUrl>[0];
        let sandbox: sinon.SinonSandbox;
        let warnStub: sinon.SinonStub;
        let errorStub: sinon.SinonStub;

        setup(() => {
            sandbox = sinon.createSandbox();
            warnStub = sandbox.stub(Logger, 'warn');
            errorStub = sandbox.stub(Logger, 'error');
        });

        teardown(() => {
            sandbox.restore();
        });

        function configWith(value: string): WarningConfig {
            return {
                get: (key: string, defaultValue?: unknown) =>
                    key === 'proxyUrl' ? value : defaultValue
            } as WarningConfig;
        }

        test('an invalid setting produces exactly one masked warning and no error log', () => {
            warnOnInvalidConfiguredProxyUrl(
                configWith('http://user:sekret@proxy.example:99999'),
                sanitizer
            );
            sinon.assert.calledOnce(warnStub);
            const warning = warnStub.firstCall.args.map(String).join(' ');
            assert.ok(!warning.includes('sekret'), `warning must be masked: ${warning}`);
            sinon.assert.notCalled(errorStub);
        });

        test('a valid setting produces no warning and no error log', () => {
            warnOnInvalidConfiguredProxyUrl(
                configWith('HTTP://PROXY.EXAMPLE:3128/'),
                sanitizer
            );
            sinon.assert.notCalled(warnStub);
            sinon.assert.notCalled(errorStub);
        });

        test('an empty setting produces no warning and no error log', () => {
            warnOnInvalidConfiguredProxyUrl(configWith(''), sanitizer);
            sinon.assert.notCalled(warnStub);
            sinon.assert.notCalled(errorStub);
        });
    });
});
