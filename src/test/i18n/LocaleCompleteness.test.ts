import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads the locale files as data only, so it runs in the plain Node unit lane.
 *
 * Every key of the English file exists in all 16 shipped locales with the same
 * placeholders (a missing key shows the raw key; a renamed placeholder breaks
 * substitution), and the strings that shipped as English copies in the 14
 * non-Japanese locales (#108) are translated.
 */
const LOCALES = [
    'en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'vi',
    'es', 'pt-br', 'fr', 'de', 'hi', 'id', 'it', 'ru', 'ar', 'tr'
];
const NON_ENGLISH_NON_JAPANESE = LOCALES.filter(locale => locale !== 'en' && locale !== 'ja');

// Keys that were English text in the 14 locales before #108.
const PREVIOUSLY_ENGLISH_KEYS = [
    'command.diagnoseProxy', 'config.statusBarTooltip', 'warning.unsupportedAutoConfig',
    'statusbar.autoUnsupported', 'statusbar.autoFallbackIgnoringAutoConfig',
    'statusbar.tooltip.autoUnsupported', 'statusbar.tooltip.autoFallbackIgnoringAutoConfig',
    'fallback.ignoringAutoConfig', 'config.diagnosticsEnabled', 'config.automaticRemediationEnabled',
    'config.hostUserLockEnabled', 'config.automaticRetryEnabled', 'config.remediationDelayedRetryMs',
    'config.remediationFlapWindowMs', 'config.remediationFlapMaxAttempts', 'config.remediationFlapCooldownMs',
    'config.notificationCooldownMs', 'config.slowDiagnosticsTtlMs', 'config.terminalOffMaskingEnabled',
    'config.notificationLevel', 'config.windowsActionsEnabled', 'config.credentialTargetPolicy',
    'config.legacyEnvFirstAutoDetection', 'action.openNewTerminal', 'action.reloadWindow',
    'remediation.notification.applyFailed', 'remediation.notification.issueDetected',
    'action.allowPlaintextWrite', 'remediation.notification.credentialConsentRequired',
    'command.resetWinHttpProxy', 'action.resetWinHttpProxy', 'windowsAction.notWindows',
    'windowsAction.disabled', 'windowsAction.resetWinHttpConfirm', 'windowsAction.resetWinHttpSuccess',
    'windowsAction.resetWinHttpFailed', 'diagnose.reason.wininetWpad', 'diagnose.reason.gnomeAuto',
    'diagnose.reason.macosPac', 'diagnose.target.linuxGnome', 'diagnose.target.macosNetwork'
];

// Identical in every language on purpose: a placeholder URL, an npm setting name,
// a VS Code setting name.
const SAME_IN_EVERY_LOCALE = new Set([
    'prompt.proxyUrlPlaceholder',
    'diagnose.target.npmNoproxy',
    'diagnose.target.vscodeHttpProxy'
]);

function load(locale: string): Record<string, string> {
    const file = path.resolve(__dirname, '..', '..', '..', 'src', 'i18n', 'locales', `${locale}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function placeholders(value: string): string {
    return (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
}

suite('Locale files stay complete (#108)', () => {
    const english = load('en');

    test('every English key exists in every locale with the same placeholders', () => {
        for (const locale of LOCALES) {
            const messages = load(locale);
            for (const [key, value] of Object.entries(english)) {
                assert.strictEqual(typeof messages[key], 'string', `${locale}.json is missing ${key}`);
                assert.strictEqual(
                    placeholders(messages[key]),
                    placeholders(value),
                    `${locale}.json ${key} placeholders differ from en`
                );
            }
        }
    });

    test('no locale has a key English lacks', () => {
        for (const locale of LOCALES) {
            const extra = Object.keys(load(locale)).filter(key => !(key in english));
            assert.deepStrictEqual(extra, [], `${locale}.json has keys en.json lacks`);
        }
    });

    test('the strings that shipped as English copies are translated in the 14 other locales', () => {
        for (const locale of NON_ENGLISH_NON_JAPANESE) {
            const messages = load(locale);
            const stillEnglish = PREVIOUSLY_ENGLISH_KEYS.filter(
                key => messages[key] === english[key] && !SAME_IN_EVERY_LOCALE.has(key)
            );
            assert.deepStrictEqual(stillEnglish, [], `${locale}.json still has English text`);
        }
    });

    test('the credential consent text names the Settings Sync setting in every locale (#108)', () => {
        const key = 'remediation.notification.credentialConsentRequired';
        for (const locale of LOCALES) {
            const text = load(locale)[key];
            assert.ok(text.includes('settingsSync.ignoredSettings'), `${locale}.json ${key} lacks settingsSync.ignoredSettings`);
            assert.ok(text.includes('http.proxy'), `${locale}.json ${key} lacks http.proxy`);
            assert.ok(text.includes('settings.json'), `${locale}.json ${key} lost the settings.json example`);
        }
        assert.ok(PREVIOUSLY_ENGLISH_KEYS.includes(key), 'the translated-key rule covers the consent text');
    });

    test('the new Off warning is translated in every locale and keeps its target list placeholder', () => {
        for (const locale of LOCALES.filter(l => l !== 'en')) {
            const messages = load(locale);
            for (const key of ['warning.proxyOffUnverified', 'statusbar.tooltip.proxyOffUnverified']) {
                assert.notStrictEqual(messages[key], english[key], `${locale}.json ${key} is still English`);
            }
            assert.ok(messages['warning.proxyOffUnverified'].includes('{targets}'), locale);
        }
    });
});
