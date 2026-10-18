/**
 * One canonical proxy URL form (#108, item 8).
 * Real-world spellings that WHATWG accepts must be validated and stored in
 * their canonical form; everything invalid for a security reason stays invalid.
 */
import * as assert from 'assert';
import * as fc from 'fast-check';
import type * as vscode from 'vscode';
import { canonicalizeProxyUrl, ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { ProxyApplier } from '../core/ProxyApplier';
import { resolveProxyApplyOptions } from '../core/ProxyApplyPlan';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { InputSanitizer } from '../validation/InputSanitizer';
import { I18nManager } from '../i18n/I18nManager';
import { splitProxyUrl, buildProxyUrlWithCredentials } from '../security/ProxyCredentialStore';
import { ProxyMode, ProxyState } from '../core/types';
import { validProxyUrlGenerator } from './generators';

const PROXY_ENV_KEYS = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
];

function withCleanProxyEnv(run: () => Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const key of PROXY_ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    return run().finally(() => {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
}

function fakeExtensionContext(globalState: Map<string, unknown>, secrets: Map<string, string>) {
    return {
        globalState: {
            get: (key: string, defaultValue?: unknown) =>
                globalState.has(key) ? globalState.get(key) : defaultValue,
            update: async (key: string, value: unknown) => { globalState.set(key, value); },
            keys: () => [...globalState.keys()],
            setKeysForSync: () => {}
        },
        workspaceState: {} as vscode.Memento,
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); },
            onDidChange: () => ({ dispose: () => {} })
        },
        subscriptions: []
    } as unknown as vscode.ExtensionContext;
}

suite('Proxy URL canonical form (#108)', () => {
    let validator: ProxyUrlValidator;

    setup(() => {
        I18nManager.getInstance().initialize('en');
        validator = new ProxyUrlValidator();
    });

    suite('accepted and canonicalized', () => {
        const cases: Array<{ input: string; canonical: string }> = [
            { input: 'http://proxy.corp.com:8080/', canonical: 'http://proxy.corp.com:8080' },
            { input: 'HTTP://Proxy.Corp.com:8080', canonical: 'http://Proxy.Corp.com:8080' },
            { input: 'http://squid_proxy:3128', canonical: 'http://squid_proxy:3128' },
            { input: 'http://user:100%@proxy:8080', canonical: 'http://user:100%25@proxy:8080' },
            { input: '  http://proxy:8080  ', canonical: 'http://proxy:8080' },
            { input: 'http://user:p%41ss@proxy:8080/', canonical: 'http://user:p%41ss@proxy:8080' },
            { input: 'http://u:100%%@proxy:8080', canonical: 'http://u:100%25%25@proxy:8080' }
        ];

        for (const { input, canonical } of cases) {
            test(`${JSON.stringify(input)} -> ${canonical}`, () => {
                assert.strictEqual(canonicalizeProxyUrl(input), canonical);
                const result = validator.validate(input);
                assert.strictEqual(result.isValid, true, result.errors.join(', '));
                assert.strictEqual(result.normalizedUrl, canonical);
            });
        }

        test('percent-escape applies to the userinfo only', () => {
            // '%' in the host still fails WHATWG parsing; nothing is rewritten there.
            const result = validator.validate('http://pro%xy:8080');
            assert.strictEqual(result.isValid, false);
        });
    });

    suite('still rejected', () => {
        const rejected = [
            'http://proxy:8080/path',
            'http://proxy:8080/?x',
            'http://proxy:8080#f',
            'http://pro xy:8080',
            'http://a@b@proxy:8080',
            'http://proxy:8080;rm',
            'http://u:p%3Brm@proxy:8080',
            'ftp://proxy:21',
            'http://::1:8080',
            'http://proxy:99999',
            'http://proxy:8080//'
        ];

        for (const url of rejected) {
            test(`${JSON.stringify(url)} is invalid`, () => {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false, `expected rejection of ${url}`);
                assert.strictEqual(result.normalizedUrl, undefined);
            });
        }
    });

    suite('property: canonical form preserves accepted URLs', () => {
        test('every URL the validator already accepted is unchanged by canonicalization', () => {
            fc.assert(
                fc.property(validProxyUrlGenerator(), (url) => {
                    const result = validator.validate(url);
                    assert.strictEqual(result.isValid, true, `${url} unexpectedly rejected: ${result.errors.join(', ')}`);
                    assert.strictEqual(canonicalizeProxyUrl(url), url);
                    assert.strictEqual(result.normalizedUrl, url);
                }),
                { numRuns: Number(process.env.OTAK_PROXY_PROPERTY_RUNS) || 100 }
            );
        });

        test('only the scheme letter case may differ (upper-case input)', () => {
            fc.assert(
                fc.property(validProxyUrlGenerator(), (url) => {
                    const upper = url.replace(/^https?:\/\//, scheme => scheme.toUpperCase());
                    assert.strictEqual(canonicalizeProxyUrl(upper), url);
                }),
                { numRuns: Number(process.env.OTAK_PROXY_PROPERTY_RUNS) || 100 }
            );
        });
    });

    suite('detection stores the canonical form', () => {
        test('HTTP_PROXY with a trailing slash is detected and normalized', async () => {
            await withCleanProxyEnv(async () => {
                process.env.HTTP_PROXY = 'http://proxy.corp.com:8080/';
                const detector = new SystemProxyDetector(['environment']);
                const result = await detector.detectSystemProxyWithSource();
                assert.strictEqual(result.proxyUrl, 'http://proxy.corp.com:8080');
                assert.strictEqual(result.httpUrl, 'http://proxy.corp.com:8080');
                assert.strictEqual(result.source, 'environment');
            });
        });
    });

    suite('persisted split state validates after reload', () => {
        function createApplier(stateManager: ProxyStateManager) {
            const npmKeyCalls: Array<{ proxy?: string | null; 'https-proxy'?: string | null }> = [];
            const applier = new ProxyApplier(
                {
                    setProxy: async () => ({ success: true }),
                    unsetProxy: async () => ({ success: true })
                } as never,
                {
                    setProxy: async () => ({ success: true }),
                    unsetProxy: async () => ({ success: true })
                } as never,
                {
                    setProxy: async () => ({ success: true }),
                    setProxyKeys: async (values: { proxy?: string | null; 'https-proxy'?: string | null }) => {
                        npmKeyCalls.push(values);
                        return { success: true };
                    },
                    unsetProxy: async () => ({ success: true })
                } as never,
                new ProxyUrlValidator(),
                new InputSanitizer(),
                {
                    showSuccess: () => {},
                    showError: () => {},
                    showWarning: () => {}
                } as never,
                stateManager,
                {
                    setProxy: async () => ({ success: true }),
                    setProxyByScheme: async () => ({ success: true }),
                    unsetProxy: async () => ({ success: true })
                } as never
            );
            return { applier, npmKeyCalls };
        }

        test('credential-bearing split URLs persisted with a trailing slash apply without invalidProxyUrl', async () => {
            // Persisted form carries no credentials and ends with '/', because
            // sanitization writes new URL(...).toString() output.
            const state: ProxyState = {
                mode: ProxyMode.Auto,
                autoProxyKind: 'perSchemeProxy',
                autoProxyUrl: 'http://user:pass@proxy-a.example.com:8080',
                autoHttpProxyUrl: 'http://user:pass@proxy-a.example.com:8080',
                autoHttpsProxyUrl: 'http://user:pass@proxy-b.example.com:8443'
            };

            const globalState = new Map<string, unknown>();
            const firstSecrets = new Map<string, string>();
            await new ProxyStateManager(fakeExtensionContext(globalState, firstSecrets)).saveState(state);

            const persisted = globalState.get('proxyState') as ProxyState;
            assert.strictEqual(persisted.autoHttpProxyUrl, 'http://proxy-a.example.com:8080/');

            await withCleanProxyEnv(async () => {
                // A fresh window (no SecretStorage contents yet; restoring split
                // credentials is #108 task 03) reads the persisted form back.
                const freshManager = new ProxyStateManager(
                    fakeExtensionContext(globalState, new Map<string, string>())
                );
                const reloaded = await freshManager.getState();
                assert.strictEqual(reloaded.autoHttpProxyUrl, 'http://proxy-a.example.com:8080/');
                assert.strictEqual(reloaded.autoHttpsProxyUrl, 'http://proxy-b.example.com:8443/');

                const { applier, npmKeyCalls } = createApplier(freshManager);
                // The plan is resolved once upstream; the applier writes it verbatim (#108).
                const planOptions = resolveProxyApplyOptions(reloaded.autoProxyUrl!, { silent: true }, reloaded);
                const result = await applier.applyProxyDetailed(reloaded.autoProxyUrl!, true, planOptions);

                assert.strictEqual(result.success, true, JSON.stringify(result.errors));
                assert.deepStrictEqual(npmKeyCalls, [{
                    proxy: 'http://proxy-a.example.com:8080/',
                    'https-proxy': 'http://proxy-b.example.com:8443/'
                }]);
            });
        });
    });

    suite('credential round trip', () => {
        // WHATWG strips tab/CR/LF outright, so they are removed. The grapheme
        // unit covers non-ASCII and astral credentials that a plain fc.string()
        // never produced (fc 4.3.0 defaults to ASCII graphemes).
        const credentialStringArb = fc.string({
            unit: fc.oneof(
                fc.constantFrom('%', '@', ':', '/', '?', '#', ' '),
                fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
            )
        }).map((s: string) => s.replace(/[\t\n\r]/g, ''));
        const credentialArb = fc.tuple(credentialStringArb, credentialStringArb)
            .filter(([username, password]) => Boolean(username || password));

        test('the credential domain actually contains non-ASCII and reserved characters', () => {
            const samples = fc.sample(credentialArb, { numRuns: 2000, seed: 42 });
            const codePoints = samples.flatMap(([username, password]) =>
                [...username, ...password].map(c => c.codePointAt(0)!));
            const joined = samples.flat().join('');
            assert.ok(codePoints.some(cp => cp > 0x7F), 'no non-ASCII code point sampled');
            assert.ok(codePoints.some(cp => cp > 0xFFFF), 'no astral code point sampled');
            for (const ch of ['%', '@', ':', '/', '?', '#', ' ']) {
                assert.ok(joined.includes(ch), `${JSON.stringify(ch)} never sampled`);
            }
        });

        test('splitProxyUrl(buildProxyUrlWithCredentials(u, p)) decodes to u and p', () => {
            fc.assert(
                fc.property(credentialArb, ([username, password]) => {
                    const built = buildProxyUrlWithCredentials(
                        'http://proxy.example.com:8080',
                        { username, password }
                    );
                    const split = splitProxyUrl(built);
                    assert.deepStrictEqual(
                        split.credentials,
                        { username, password },
                        `round trip failed for ${JSON.stringify({ username, password })} -> ${built}`
                    );
                }),
                { numRuns: Number(process.env.OTAK_PROXY_PROPERTY_RUNS) || 100 }
            );
        });

        test('credentials without % keep the byte-identical pre-#108 encoding', () => {
            const noPercentArb = credentialArb
                .map(([username, password]): [string, string] => [
                    username.replace(/%/g, ''),
                    password.replace(/%/g, '')
                ]);

            fc.assert(
                fc.property(noPercentArb, ([username, password]) => {
                    // Reference output = what the previous implementation produced.
                    const parsed = new URL('http://proxy.example.com:8080');
                    if (username) {
                        parsed.username = username;
                    }
                    if (password) {
                        parsed.password = password;
                    }
                    let expected = parsed.toString();
                    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
                        expected = expected.slice(0, -1);
                    }

                    assert.strictEqual(
                        buildProxyUrlWithCredentials('http://proxy.example.com:8080', { username, password }),
                        expected
                    );
                }),
                { numRuns: Number(process.env.OTAK_PROXY_PROPERTY_RUNS) || 100 }
            );
        });

        test('passwords containing % survive a SecretStorage round trip', () => {
            const split = splitProxyUrl('http://user:100%25@proxy.example.com:8080');
            assert.deepStrictEqual(split.credentials, { username: 'user', password: '100%' });
            const rebuilt = buildProxyUrlWithCredentials(split.publicUrl, split.credentials!);
            assert.strictEqual(rebuilt, 'http://user:100%25@proxy.example.com:8080');
            assert.deepStrictEqual(splitProxyUrl(rebuilt).credentials, { username: 'user', password: '100%' });
        });

        test('fixed non-ASCII credentials round trip through UTF-8 percent-encoding', () => {
            const credentials = { username: 'ユーザー', password: 'pässwörd😀%' };
            const built = buildProxyUrlWithCredentials('http://proxy.example.com:8080', credentials);
            assert.strictEqual(
                built,
                'http://%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC:p%C3%A4ssw%C3%B6rd%F0%9F%98%80%25@proxy.example.com:8080'
            );
            assert.deepStrictEqual(splitProxyUrl(built).credentials, credentials);
        });

        test('a password that looks like an escape does not decode differently', () => {
            // Stored credentials are already decoded; a literal 'a%41b' password
            // must rebuild as 'a%2541b' so it decodes back to 'a%41b'.
            const rebuilt = buildProxyUrlWithCredentials(
                'http://proxy.example.com:8080',
                { username: 'u', password: 'a%41b' }
            );
            assert.strictEqual(rebuilt, 'http://u:a%2541b@proxy.example.com:8080');
            assert.deepStrictEqual(
                splitProxyUrl(rebuilt).credentials,
                { username: 'u', password: 'a%41b' }
            );
        });
    });
});
