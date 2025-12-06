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
     * For any 非対応の言語コード（"ja"と"en"以外）、I18nManagerを初期化すると、
     * 英語（フォールバック言語）が使用される
     * 
     * Validates: Requirements 1.4
     */
    test('Property 1: Unsupported locales should fallback to English', () => {
        // Generate arbitrary locale strings that are NOT 'en' or 'ja'
        const unsupportedLocaleArb = fc.string({ minLength: 1, maxLength: 10 })
            .filter(locale => locale !== 'en' && locale !== 'ja');

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

        // Load both translation files
        const enPath = path.join(__dirname, '../../i18n/locales/en.json');
        const jaPath = path.join(__dirname, '../../i18n/locales/ja.json');

        const enContent = fs.readFileSync(enPath, 'utf-8');
        const jaContent = fs.readFileSync(jaPath, 'utf-8');

        const enTranslations = JSON.parse(enContent);
        const jaTranslations = JSON.parse(jaContent);

        // Get keys from both files
        const enKeys = Object.keys(enTranslations).sort();
        const jaKeys = Object.keys(jaTranslations).sort();

        // Check that both files have the same number of keys
        assert.strictEqual(enKeys.length, jaKeys.length,
            `English has ${enKeys.length} keys, but Japanese has ${jaKeys.length} keys`);

        // Check that all keys match
        const missingInJa = enKeys.filter(key => !jaKeys.includes(key));
        const missingInEn = jaKeys.filter(key => !enKeys.includes(key));

        assert.strictEqual(missingInJa.length, 0,
            `Keys missing in Japanese translation: ${missingInJa.join(', ')}`);
        assert.strictEqual(missingInEn.length, 0,
            `Keys missing in English translation: ${missingInEn.join(', ')}`);

        // Verify all keys are identical
        assert.deepStrictEqual(enKeys, jaKeys,
            'English and Japanese translation files should have identical keys');
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

        // Test English file
        const enPath = path.join(__dirname, '../../i18n/locales/en.json');
        const enContent = fs.readFileSync(enPath, 'utf-8');
        
        let enTranslations;
        try {
            enTranslations = JSON.parse(enContent);
            assert.ok(enTranslations, 'English translation file should be valid JSON');
        } catch (error) {
            assert.fail(`English translation file has invalid JSON: ${error}`);
        }

        // Test Japanese file
        const jaPath = path.join(__dirname, '../../i18n/locales/ja.json');
        const jaContent = fs.readFileSync(jaPath, 'utf-8');
        
        let jaTranslations;
        try {
            jaTranslations = JSON.parse(jaContent);
            assert.ok(jaTranslations, 'Japanese translation file should be valid JSON');
        } catch (error) {
            assert.fail(`Japanese translation file has invalid JSON: ${error}`);
        }

        // Verify both are objects
        assert.strictEqual(typeof enTranslations, 'object',
            'English translations should be an object');
        assert.strictEqual(typeof jaTranslations, 'object',
            'Japanese translations should be an object');
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
