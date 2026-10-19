import * as assert from 'assert';
import { buildProxyValidationSuggestions } from '../../core/ProxyValidationMessages';
import { I18nManager } from '../../i18n/I18nManager';
import { INVALID_DNS_HOSTNAME_ERROR } from '../../validation/ProxyHost';
import { ProxyUrlValidator } from '../../validation/ProxyUrlValidator';

suite('Proxy validation messages (#108)', () => {
    const i18n = I18nManager.getInstance();
    const validator = new ProxyUrlValidator();

    teardown(() => i18n.initialize('en'));

    test('the validator accepts an underscore in a hostname', () => {
        assert.strictEqual(validator.validate('http://my_proxy.example.com:8080').isValid, true);
    });

    test('the hostname error the validator returns is the one the message mapping translates, and it lists underscores', () => {
        const result = validator.validate('http://bad!host.example.com:8080');
        assert.deepStrictEqual(result.errors, [INVALID_DNS_HOSTNAME_ERROR]);

        i18n.initialize('en');
        const [message] = buildProxyValidationSuggestions(result.errors);

        assert.strictEqual(message, i18n.t('validation.proxyUrl.hostnameInvalid'));
        assert.notStrictEqual(message, 'validation.proxyUrl.hostnameInvalid', 'the key is resolved');
        assert.ok(/underscore/i.test(message), message);
    });

    test('the translated message is localized, not the English validator text', () => {
        i18n.initialize('ja');
        const [message] = buildProxyValidationSuggestions([INVALID_DNS_HOSTNAME_ERROR]);

        assert.notStrictEqual(message, INVALID_DNS_HOSTNAME_ERROR);
        assert.ok(message.includes('アンダースコア'), message);
    });
});
