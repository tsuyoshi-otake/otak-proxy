import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { I18nManager } from '../../i18n/I18nManager';
import { formatDiagnosticsNotification } from '../../commands/DiagnoseProxyCommand';

/**
 * Guards issue #13: the Diagnose Proxy command hard-coded English strings, so
 * every non-English user saw English in the notification/output channel. All of
 * its strings are now locale keys that must exist in every one of the 16 shipped
 * locale files, with matching placeholders so runtime substitution never breaks.
 */
const SUPPORTED_LOCALES = [
    'en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'vi',
    'es', 'pt-br', 'fr', 'de', 'hi', 'id', 'it', 'ru', 'ar', 'tr'
];

// The exact keys DiagnoseProxyCommand resolves through I18nManager.t().
const DIAGNOSE_KEYS = [
    'diagnose.noIssues',
    'diagnose.issueCountOne',
    'diagnose.issueCountMany',
    'diagnose.summaryNoPrimary',
    'diagnose.summary',
    'diagnose.extraMore',
    'diagnose.generatedAt',
    'diagnose.failed',
    'diagnose.target.gitGlobalProxy',
    'diagnose.target.gitGlobalHttpsProxy',
    'diagnose.target.gitOverride',
    'diagnose.target.npmUserProxy',
    'diagnose.target.npmNoproxy',
    'diagnose.target.vscodeHttpProxy',
    'diagnose.target.vscodeHttpProxySupport',
    'diagnose.target.vscodeLaunchArgv',
    'diagnose.target.terminalEnvInherited',
    'diagnose.target.terminalExisting',
    'diagnose.target.diagnosticsChildProcess',
    'diagnose.target.windows',
    'diagnose.target.windowsWinhttp',
    'diagnose.target.windowsWininet',
    'diagnose.reason.managedProxyResidual',
    'diagnose.reason.managedProxyMismatch',
    'diagnose.reason.childProcessUnavailable',
    'diagnose.reason.windowsUnavailable',
    'diagnose.reason.proxySupportOff',
    'diagnose.reason.launchProxyFlags',
    'diagnose.reason.inheritedProxyEnv',
    'diagnose.reason.existingTerminals',
    'diagnose.reason.legacyHttpsProxy',
    'diagnose.reason.effectiveOverride',
    'diagnose.reason.npmNoproxy',
    'diagnose.reason.winhttpParseUnavailable',
    'diagnose.reason.wininetPac'
];

function localesDir(): string {
    return path.resolve(__dirname, '..', '..', '..', 'src', 'i18n', 'locales');
}

function loadLocale(locale: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(localesDir(), `${locale}.json`), 'utf8'));
}

function placeholders(value: string): string[] {
    return (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
}

suite('Diagnose Proxy localization', () => {
    test('every supported locale defines all diagnose.* keys as non-empty strings', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const messages = loadLocale(locale);
            for (const key of DIAGNOSE_KEYS) {
                const value = messages[key];
                assert.strictEqual(typeof value, 'string', `${locale}.json must define ${key} as a string`);
                assert.ok((value as string).trim().length > 0, `${locale}.json ${key} must be non-empty`);
            }
        }
    });

    test('placeholders are identical across every locale (substitution cannot break)', () => {
        const en = loadLocale('en');
        for (const key of DIAGNOSE_KEYS) {
            const expected = placeholders(en[key] as string);
            for (const locale of SUPPORTED_LOCALES) {
                const actual = placeholders(loadLocale(locale)[key] as string);
                assert.deepStrictEqual(
                    actual,
                    expected,
                    `${locale}.json ${key} placeholders ${JSON.stringify(actual)} must match en ${JSON.stringify(expected)}`
                );
            }
        }
    });

    test('the product/channel name is preserved verbatim in the summary strings', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const messages = loadLocale(locale);
            for (const key of ['diagnose.summary', 'diagnose.summaryNoPrimary']) {
                assert.ok(
                    (messages[key] as string).includes('Otak Proxy Diagnostics'),
                    `${locale}.json ${key} must keep the "Otak Proxy Diagnostics" channel name`
                );
            }
        }
    });

    test('formatDiagnosticsNotification returns localized text (ja differs from en)', () => {
        const i18n = I18nManager.getInstance();
        const report = { issueCount: 0, issues: [] };
        try {
            i18n.initialize('en');
            const en = formatDiagnosticsNotification(report);
            i18n.initialize('ja');
            const ja = formatDiagnosticsNotification(report);

            assert.strictEqual(en, 'Proxy diagnostics completed: no issues found.');
            assert.notStrictEqual(ja, en, 'Japanese output must not equal the English output');
            assert.ok(ja.includes('問題'), `Japanese output should be localized, got: ${ja}`);
        } finally {
            // Restore the default locale so we do not leak singleton state.
            i18n.initialize('en');
        }
    });
});
