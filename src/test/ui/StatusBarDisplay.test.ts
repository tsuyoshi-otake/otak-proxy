import * as assert from 'assert';
import { ProxyMode } from '../../core/types';
import { I18nManager } from '../../i18n/I18nManager';
import { getStatusBarDisplay } from '../../ui/StatusBarDisplay';
import { InputSanitizer } from '../../validation/InputSanitizer';

suite('StatusBarDisplay convergence states', () => {
    const i18n = I18nManager.getInstance();
    const sanitizer = new InputSanitizer();

    setup(() => i18n.initialize('en'));

    test('uses a stable Auto icon when no operation is in progress', () => {
        const display = getStatusBarDisplay({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080'
        }, true, i18n, sanitizer);

        assert.ok(display.text.startsWith('$(sync)'));
        assert.ok(!display.text.includes('~spin'));
    });

    test('does not expose a username-only token in text or tooltip', () => {
        const token = 'ghp_SECRETTOKEN123';
        const display = getStatusBarDisplay({
            mode: ProxyMode.Auto,
            autoProxyUrl: `http://${token}@proxy.example:8080`
        }, true, i18n, sanitizer);

        const serialized = JSON.stringify(display);
        assert.ok(!serialized.includes(token));
        assert.ok(serialized.includes('****'));
    });

    test('shows a warning icon for a failed Off convergence instead of false clean OFF', () => {
        const display = getStatusBarDisplay({
            mode: ProxyMode.Off,
            lastError: 'Git configuration failed',
            targetOutcomes: { git: 'failed' }
        }, true, i18n, sanitizer);

        assert.ok(display.text.startsWith('$(warning)'));
        assert.ok(display.statusText.includes('Git configuration failed'));
    });

    test('does not treat an intentionally preserved external proxy as a convergence failure', () => {
        const display = getStatusBarDisplay({
            mode: ProxyMode.Off,
            targetOutcomes: { git: 'preservedExternal' }
        }, true, i18n, sanitizer);

        assert.ok(display.text.startsWith('$(circle-slash)'));
    });

    test('does not show successful Auto when apply was blocked before any target write', () => {
        const display = getStatusBarDisplay({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            applyBlocked: 'untrustedWorkspace',
            lastError: 'Proxy settings were not changed because the workspace is untrusted.',
            targetOutcomes: {
                git: 'failed',
                vscode: 'failed',
                npm: 'failed',
                terminalEnv: 'failed'
            }
        }, true, i18n, sanitizer);

        assert.ok(display.text.startsWith('$(warning)'), `expected warning icon, got: ${display.text}`);
        assert.ok(!display.text.startsWith('$(sync)'), `must not show successful Auto: ${display.text}`);
        assert.ok(
            display.text.includes('blocked') || display.statusText.toLowerCase().includes('untrusted'),
            `must surface apply-blocked vs desired Auto: ${display.text} / ${display.statusText}`
        );
    });

    test('does not show a clean Off when disable was blocked', () => {
        const display = getStatusBarDisplay({
            mode: ProxyMode.Off,
            applyBlocked: 'untrustedWorkspace',
            lastError: 'Proxy settings were not changed because the workspace is untrusted.',
            targetOutcomes: {
                git: 'failed',
                vscode: 'failed',
                npm: 'failed',
                terminalEnv: 'failed'
            }
        }, true, i18n, sanitizer);

        assert.ok(display.text.startsWith('$(warning)'), `expected warning Off, got: ${display.text}`);
        assert.ok(!display.text.startsWith('$(circle-slash)'), `must not show clean Off: ${display.text}`);
    });
});
