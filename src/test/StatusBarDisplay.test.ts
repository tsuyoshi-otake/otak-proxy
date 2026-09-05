import * as assert from 'assert';
import { ProxyMode, ProxyState } from '../core/types';
import type { I18nManager } from '../i18n/I18nManager';
import { getStatusBarDisplay } from '../ui/StatusBarDisplay';
import { InputSanitizer } from '../validation/InputSanitizer';

function stubI18n(): I18nManager {
    const messages: Record<string, string> = {
        'statusbar.autoOff': 'Auto: OFF',
        'statusbar.autoNoProxy': 'Auto: No system proxy',
        'statusbar.autoUnsupported': 'Auto: {kind} unsupported',
        'statusbar.autoFallback': 'Auto (Fallback): {url}',
        'statusbar.autoFallbackIgnoringAutoConfig': 'Auto (Fallback, ignoring {kind}): {url}',
        'statusbar.tooltip.autoOff': 'auto off',
        'statusbar.tooltip.autoModeNoProxy': 'no proxy',
        'statusbar.tooltip.autoUnsupported': 'unsupported {kind}',
        'statusbar.tooltip.autoFallback': 'fallback {url}',
        'statusbar.tooltip.autoFallbackIgnoringAutoConfig': 'ignoring {kind} {url}'
    };
    return {
        t(key: string, params?: Record<string, string>): string {
            let text = messages[key] ?? key;
            for (const [name, value] of Object.entries(params ?? {})) {
                text = text.split(`{${name}}`).join(value);
            }
            return text;
        }
    } as I18nManager;
}

suite('StatusBarDisplay auto-config (#58)', () => {
    const i18n = stubI18n();
    const sanitizer = new InputSanitizer();

    test('unsupported PAC is not Off and not No system proxy', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            lastDetectionKind: 'pac',
            lastDetectionCapability: 'unsupported',
            systemProxyDetected: true
        };

        const display = getStatusBarDisplay(state, true, i18n, sanitizer);
        assert.ok(display.text.includes('PAC unsupported'));
        assert.ok(!display.text.includes('OFF'));
        assert.ok(!display.text.includes('No system proxy'));
        assert.ok(display.text.startsWith('$(warning)'));
    });

    test('fallback that ignores PAC says so', () => {
        const state: ProxyState = {
            mode: ProxyMode.Auto,
            usingFallbackProxy: true,
            fallbackProxyUrl: 'http://manual.example:3128',
            autoProxyUrl: 'http://manual.example:3128',
            lastDetectionKind: 'pac',
            lastDetectionCapability: 'unsupported'
        };

        const display = getStatusBarDisplay(state, true, i18n, sanitizer);
        assert.ok(display.text.includes('ignoring PAC'));
        assert.ok(display.text.includes('http://manual.example:3128'));
        assert.ok(!display.text.includes('No system proxy'));
    });
});
