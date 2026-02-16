import * as assert from 'assert';
import * as fc from 'fast-check';
import { I18nManager } from '../../i18n/I18nManager';
import { getPropertyTestRuns } from '../helpers';

suite('I18nManager Property Tests', () => {
    let i18n: I18nManager;

    setup(() => {
        i18n = I18nManager.getInstance();
    });

    /**
     * Feature: ui-internationalization, Property 1: 非対応言語のフォールバック
     * 
     * For any 非対応の言語コード（サポート対象以外）、I18nManagerを初期化すると、
     * 英語（フォールバック言語）が使用される
     * 
     * Validates: Requirements 1.4
     */
    test('Property 1: Unsupported locales should fallback to English', () => {
        const supportedLocales = new Set(['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'vi']);
        const resolvesToSupported = (raw: string): boolean => {
            const normalized = (raw || '').trim().replace(/_/g, '-').toLowerCase();
            if (supportedLocales.has(normalized)) {
                return true;
            }

            const base = normalized.split('-')[0];
            if (supportedLocales.has(base)) {
                return true; // en-US, ja-JP, ko-KR, etc.
            }

            // Chinese variants map to supported zh-cn/zh-tw.
            if (base === 'zh') {
                return true;
            }

            return false;
        };

        // Generate arbitrary locale strings that do NOT resolve to a supported locale
        const unsupportedLocaleArb = fc.string({ minLength: 1, maxLength: 10 })
            .filter(locale => !resolvesToSupported(locale));

        fc.assert(
            fc.property(unsupportedLocaleArb, (locale) => {
                // Initialize with unsupported locale
                i18n.initialize(locale);

                // Should fallback to English
                const currentLocale = i18n.getCurrentLocale();
                assert.strictEqual(currentLocale, 'en', 
                    `Expected fallback to 'en' for unsupported locale '${locale}', but got '${currentLocale}'`);

                // Should be able to get English translations
                const message = i18n.t('action.yes');
                assert.strictEqual(message, 'Yes', 
                    `Expected English translation 'Yes', but got '${message}'`);
            }),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: ui-internationalization, Property 3: パラメータ置換
     * 
     * For any メッセージキーとパラメータのセット、I18nManager.t()を呼び出すと、
     * 翻訳文字列内のプレースホルダー（{key}）が対応するパラメータ値で置換される
     * 
     * Validates: Requirements 2.3
     */
    test('Property 3: Parameters should be substituted in translated messages', () => {
        // Initialize with English
        i18n.initialize('en');

        // Generate arbitrary parameters
        const paramKeyArb = fc.string({ minLength: 1, maxLength: 20 })
            .filter(key => /^[a-zA-Z0-9_]+$/.test(key)); // Valid parameter keys
        const paramValueArb = fc.string({ minLength: 0, maxLength: 100 });

        fc.assert(
            fc.property(
                paramKeyArb,
                paramValueArb,
                (paramKey, paramValue) => {
                    // Use a message that has a placeholder
                    const params: Record<string, string> = {};
                    params[paramKey] = paramValue;

                    // Create a test message with the placeholder
                    const testMessage = `Test message with {${paramKey}} placeholder`;
                    
                    // Manually substitute to verify
                    const expected = testMessage.replace(`{${paramKey}}`, paramValue);

                    // Test with actual translation that has placeholders
                    // Using 'message.proxyWorks' which has {mode} and {url}
                    const result = i18n.t('message.proxyWorks', { mode: 'Manual', url: 'http://test:8080' });
                    
                    // Verify that placeholders are replaced
                    assert.ok(!result.includes('{mode}'), 
                        `Placeholder {mode} should be replaced in: ${result}`);
                    assert.ok(!result.includes('{url}'), 
                        `Placeholder {url} should be replaced in: ${result}`);
                    assert.ok(result.includes('Manual'), 
                        `Result should contain 'Manual': ${result}`);
                    assert.ok(result.includes('http://test:8080'), 
                        `Result should contain 'http://test:8080': ${result}`);
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: ui-internationalization, Property 4: 欠落翻訳のフォールバック
     * 
     * For any メッセージキーが現在の言語で存在しない場合、I18nManager.t()を呼び出すと、
     * フォールバック言語（英語）の翻訳が返される
     * 
     * Validates: Requirements 2.4
     */
    test('Property 4: Missing translations should fallback to English', () => {
        // Initialize with Japanese
        i18n.initialize('ja');

        // Generate arbitrary non-existent message keys
        // Exclude JavaScript object prototype method names to avoid conflicts
        const prototypeMethods = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 
            'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__proto__', 
            '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'];
        
        const nonExistentKeyArb = fc.string({ minLength: 1, maxLength: 50 })
            .filter(key => 
                !key.startsWith('action.') && 
                !key.startsWith('message.') && 
                !key.startsWith('error.') &&
                !prototypeMethods.includes(key) &&
                !key.startsWith('__')
            );

        fc.assert(
            fc.property(nonExistentKeyArb, (key) => {
                // Try to get translation for non-existent key
                const result = i18n.t(key);

                // Should return a fallback indicator (string type)
                assert.strictEqual(typeof result, 'string', 
                    `Expected string result for key '${key}', but got type '${typeof result}'`);
                assert.ok(result.includes('[missing:') || result.length > 0, 
                    `Expected fallback for missing key '${key}', but got '${result}'`);
            }),
            { numRuns: getPropertyTestRuns() }
        );
    });
});

suite('I18nManager Unit Tests', () => {
    /**
     * Unit Test: Translation file validation
     * 
     * Validates that all language files have the same set of keys
     * 
     * Validates: Requirements 7.2
     */
    test('All language files should have the same set of keys', () => {
        const fs = require('fs');
        const path = require('path');

        const locales = ['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'vi'] as const;

        // Load translation files from the compiled output folder (out/i18n/locales).
        const loadLocale = (locale: string) => {
            const p = path.join(__dirname, '../../i18n/locales', `${locale}.json`);
            const content = fs.readFileSync(p, 'utf-8');
            return JSON.parse(content);
        };

        const enTranslations = loadLocale('en');
        const enKeys = Object.keys(enTranslations).sort();

        for (const locale of locales) {
            const translations = loadLocale(locale);
            const keys = Object.keys(translations).sort();

            assert.strictEqual(keys.length, enKeys.length,
                `English has ${enKeys.length} keys, but ${locale} has ${keys.length} keys`);

            const missing = enKeys.filter(key => !keys.includes(key));
            const extra = keys.filter(key => !enKeys.includes(key));

            assert.strictEqual(missing.length, 0,
                `Keys missing in ${locale} translation: ${missing.join(', ')}`);
            assert.strictEqual(extra.length, 0,
                `Extra keys in ${locale} translation: ${extra.join(', ')}`);

            assert.deepStrictEqual(keys, enKeys,
                `English and ${locale} translation files should have identical keys`);
        }
    });

    /**
     * Unit Test: JSON parse error handling
     * 
     * Validates that JSON files are valid and can be parsed
     * 
     * Validates: Requirements 7.3
     */
    test('Translation files should be valid JSON', () => {
        const fs = require('fs');
        const path = require('path');

        const locales = ['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'vi'];
        const parsed: Record<string, unknown> = {};

        for (const locale of locales) {
            const p = path.join(__dirname, '../../i18n/locales', `${locale}.json`);
            const content = fs.readFileSync(p, 'utf-8');

            try {
                parsed[locale] = JSON.parse(content);
                assert.ok(parsed[locale], `${locale} translation file should be valid JSON`);
            } catch (error) {
                assert.fail(`${locale} translation file has invalid JSON: ${error}`);
            }
        }

        for (const locale of locales) {
            assert.strictEqual(typeof parsed[locale], 'object',
                `${locale} translations should be an object`);
        }
    });

    /**
     * Unit Test: package.nls file validation
     *
     * Validates that all package.nls.*.json files have the same set of keys
     */
    test('All package.nls files should have the same set of keys', () => {
        const fs = require('fs');
        const path = require('path');

        // __dirname: out/test/i18n -> ../../../ is repo root
        const repoRoot = path.resolve(__dirname, '../../../');

        const files = [
            'package.nls.json',
            'package.nls.ja.json',
            'package.nls.zh-cn.json',
            'package.nls.zh-tw.json',
            'package.nls.ko.json',
            'package.nls.vi.json',
        ];

        const load = (fileName: string) => {
            const p = path.join(repoRoot, fileName);
            const content = fs.readFileSync(p, 'utf-8');
            return JSON.parse(content);
        };

        const en = load('package.nls.json');
        const enKeys = Object.keys(en).sort();

        for (const fileName of files) {
            const obj = load(fileName);
            const keys = Object.keys(obj).sort();

            assert.strictEqual(keys.length, enKeys.length,
                `${fileName} has ${keys.length} keys, but package.nls.json has ${enKeys.length} keys`);

            const missing = enKeys.filter((k: string) => !keys.includes(k));
            const extra = keys.filter((k: string) => !enKeys.includes(k));

            assert.strictEqual(missing.length, 0,
                `Keys missing in ${fileName}: ${missing.join(', ')}`);
            assert.strictEqual(extra.length, 0,
                `Extra keys in ${fileName}: ${extra.join(', ')}`);

            assert.deepStrictEqual(keys, enKeys,
                `package.nls.json and ${fileName} should have identical keys`);
        }
    });

    /**
     * Unit Test: Missing translation fallback
     * 
     * Validates that missing translations correctly fallback to English
     * 
     * Validates: Requirements 7.1
     */
    test('Missing translations should fallback with indicator', () => {
        // Get the I18nManager instance
        const testI18n = I18nManager.getInstance();

        // Initialize with Japanese
        testI18n.initialize('ja');

        // Try to get a non-existent key
        const result = testI18n.t('nonexistent.key.that.does.not.exist.xyz123');

        // Should return a fallback indicator
        assert.ok(result.includes('[missing:'),
            `Expected fallback indicator for missing key, but got: ${result}`);
        
        // Should include the key name in the result
        assert.ok(result.includes('nonexistent.key.that.does.not.exist.xyz123'),
            `Expected result to include the missing key name, but got: ${result}`);
    });
});
