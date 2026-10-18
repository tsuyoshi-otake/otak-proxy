import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { InputSanitizer } from '../../validation/InputSanitizer';
import { ProxySecretRedactor } from '../../security/ProxySecretRedactor';
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
                            host: fc.stringMatching(/^h[a-z0-9]{2,10}\.example$/),
                            shape: fc.constantFrom('url', 'bare', 'path', 'domain', 'urlSlash')
                        }),
                        { minLength: 1, maxLength: 3 }
                    ),
                    fc.array(fc.constantFrom(...alphabet), { minLength: 0, maxLength: 30 }).map(c => c.join('')),
                    (credentials, noise) => {
                        const embedded = credentials.map(c => {
                            switch (c.shape) {
                                case 'url': return `http://${c.user}:${c.pass}@${c.host}`;
                                case 'urlSlash': return `http://${c.user}:${c.slashPass}@${c.host}`;
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
    });

    suite('passwords containing unencoded "/", "?" or "#" (PR #113 review)', () => {
        const redactor = new ProxySecretRedactor();

        // Pinned by the Codex review of PR #113: a password with a raw "/",
        // "?" or "#" makes new URL() reject the input or splits the authority
        // at that character, so both consumers of the shared credential
        // patterns must still mask the userinfo up to the last "@" of the run.
        const rows: Array<{ input: string; masked: string; redacted: string }> = [
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

        test('masking stays linear on credential-run input', () => {
            const input = 'x://a:b'.repeat(40000);

            const maskStart = process.hrtime.bigint();
            sanitizer.maskPassword(input);
            const maskMs = Number(process.hrtime.bigint() - maskStart) / 1e6;

            const redactStart = process.hrtime.bigint();
            redactor.redactString(input);
            const redactMs = Number(process.hrtime.bigint() - redactStart) / 1e6;

            assert.ok(maskMs < 1000, `maskPassword took ${maskMs.toFixed(1)} ms`);
            assert.ok(redactMs < 1000, `redactString took ${redactMs.toFixed(1)} ms`);
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
