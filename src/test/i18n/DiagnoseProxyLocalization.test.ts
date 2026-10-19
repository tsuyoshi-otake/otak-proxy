import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { I18nManager } from '../../i18n/I18nManager';
import { formatDiagnosticsNotification } from '../../commands/DiagnoseProxyCommand';
import { TARGET_LABEL_KEYS, proxyTargetLabel } from '../../core/ProxyTargetLabels';
import { createApplyBlockedIssue } from '../../core/v3Types';
import type { ProxyIssue } from '../../core/v3Types';
import { vscodeRemoteNotWritableIssue } from '../../core/ProxyTargetCapability';

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
    'diagnose.reason.wininetPac',
    'diagnose.reason.gitReadUnavailable',
    'diagnose.reason.npmReadUnavailable',
    'diagnose.target.systemBypass',
    'diagnose.target.pipUserProxy',
    'diagnose.reason.gitSplitLossy',
    'diagnose.reason.vscodeSplitLossy',
    'diagnose.reason.pipSplitLossy',
    'diagnose.reason.bypassNotApplied',
    'diagnose.target.gitGlobalHttpProxy',
    'diagnose.target.npmUserHttpsProxy',
    'diagnose.target.proxyCredentials',
    'diagnose.target.workspaceApply',
    'diagnose.reason.localCredentialUnresolved',
    'diagnose.reason.applyBlockedUntrustedWorkspace',
    'diagnose.reason.applyBlockedInvalidProxyUrl',
    'diagnose.reason.applyBlockedCredentialConsent',
    'diagnose.reason.applyBlockedApplyFailed',
    'diagnose.reason.vscodeRemoteNotWritable'
];

// The ids the ownership-aware target adapters in ProxyApplier observe: the Off
// warning names a kept value by one of these.
const OWNERSHIP_TARGET_IDS = [
    'git.global.http.proxy',
    'git.global.https.proxy',
    'npm.user.proxy',
    'npm.user.https-proxy',
    'vscode.http.proxy',
    'pip.user.global.proxy'
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

    test('every ownership target id has a label key that every locale defines (the Off warning never prints a raw id)', () => {
        const i18n = I18nManager.getInstance();
        i18n.initialize('en');
        for (const id of OWNERSHIP_TARGET_IDS) {
            const key = TARGET_LABEL_KEYS[id];
            assert.ok(key, `${id} has no label key`);
            for (const locale of SUPPORTED_LOCALES) {
                assert.strictEqual(typeof loadLocale(locale)[key], 'string', `${locale}.json must define ${key}`);
            }
            assert.notStrictEqual(proxyTargetLabel(id), id, `${id} resolves to its label`);
        }
        assert.strictEqual(proxyTargetLabel('some.unknown.target'), 'some.unknown.target');
    });

    test('a credential-consent block is explained, not shown as a raw issue id', () => {
        const i18n = I18nManager.getInstance();
        try {
            i18n.initialize('en');
            const cases: Array<[ProxyIssue, RegExp]> = [
                [createApplyBlockedIssue('credentialConsent'), /plaintext config files/],
                [createApplyBlockedIssue('untrustedWorkspace'), /workspace is untrusted/],
                [createApplyBlockedIssue('invalidProxyUrl'), /proxy URL is invalid/],
                [createApplyBlockedIssue('applyFailed'), /did not complete/]
            ];
            for (const [issue, expected] of cases) {
                const text = formatDiagnosticsNotification({ issueCount: 1, issues: [issue] });
                assert.match(text, expected, issue.id);
                assert.ok(!text.includes(issue.id), `the raw id leaked into: ${text}`);
            }
        } finally {
            i18n.initialize('en');
        }
    });

    test('the remote-window http.proxy advisory is explained with both remedies, not shown as a raw issue id (#108)', () => {
        const i18n = I18nManager.getInstance();
        try {
            i18n.initialize('en');
            const issue = vscodeRemoteNotWritableIssue('apply');

            const text = formatDiagnosticsNotification({ issueCount: 1, issues: [issue] });

            assert.ok(!text.includes(issue.id), `the raw id leaked into: ${text}`);
            assert.ok(text.includes('does not write or remove'), text);
            assert.ok(text.includes('Preferences: Open Remote Settings'), 'names the command as VS Code titles it');
            assert.ok(text.includes('http.useLocalProxyConfiguration'), text);
            assert.ok(!/registration/i.test(text), 'no internal terms');
        } finally {
            i18n.initialize('en');
        }
    });

    test('every locale keeps the setting names and the command in the remote-window advisory (#108)', () => {
        for (const locale of SUPPORTED_LOCALES) {
            const reason = loadLocale(locale)['diagnose.reason.vscodeRemoteNotWritable'] as string;
            for (const token of ['http.proxy', 'http.useLocalProxyConfiguration', 'Preferences: Open Remote Settings']) {
                assert.ok(reason.includes(token), `${locale}.json diagnose.reason.vscodeRemoteNotWritable lacks ${token}`);
            }
        }
    });

    test('a missing local credential is explained, not shown as a raw issue id', () => {
        const i18n = I18nManager.getInstance();
        i18n.initialize('en');
        const issue: ProxyIssue = {
            ...createApplyBlockedIssue('applyFailed'),
            id: 'proxy.localCredential.unresolved',
            fingerprint: 'proxy.localCredential.unresolved',
            targetId: 'proxy.credentials'
        };

        const text = formatDiagnosticsNotification({ issueCount: 1, issues: [issue] });

        assert.ok(text.includes('Configure Manual Proxy'), text);
        assert.ok(!text.includes('proxy.localCredential.unresolved'), text);
    });
});
