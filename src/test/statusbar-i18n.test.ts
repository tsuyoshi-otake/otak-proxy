import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { I18nManager } from '../i18n/I18nManager';

suite('Status Bar Internationalization Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let i18nManager: I18nManager;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18nManager = I18nManager.getInstance();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('Status bar text should be localized in English', () => {
        // Initialize with English
        i18nManager.initialize('en');

        // Test Auto mode with URL
        const autoWithUrl = i18nManager.t('statusbar.autoWithUrl', { url: 'http://proxy:8080' });
        assert.strictEqual(autoWithUrl, 'Auto: http://proxy:8080');

        // Test Auto mode without URL
        const autoNoProxy = i18nManager.t('statusbar.autoNoProxy');
        assert.strictEqual(autoNoProxy, 'Auto: No system proxy');

        // Test Manual mode with URL
        const manualWithUrl = i18nManager.t('statusbar.manualWithUrl', { url: 'http://proxy:8080' });
        assert.strictEqual(manualWithUrl, 'Manual: http://proxy:8080');

        // Test Manual mode without URL
        const manualNotConfigured = i18nManager.t('statusbar.manualNotConfigured');
        assert.strictEqual(manualNotConfigured, 'Manual: Not configured');

        // Test Off mode
        const proxyOff = i18nManager.t('statusbar.proxyOff');
        assert.strictEqual(proxyOff, 'Proxy: Off');
    });

    test('Status bar text should be localized in Japanese', () => {
        // Initialize with Japanese
        i18nManager.initialize('ja');

        // Test Auto mode with URL
        const autoWithUrl = i18nManager.t('statusbar.autoWithUrl', { url: 'http://proxy:8080' });
        assert.strictEqual(autoWithUrl, 'Auto: http://proxy:8080');

        // Test Auto mode without URL
        const autoNoProxy = i18nManager.t('statusbar.autoNoProxy');
        assert.strictEqual(autoNoProxy, 'Auto: システムproxyなし');

        // Test Manual mode with URL
        const manualWithUrl = i18nManager.t('statusbar.manualWithUrl', { url: 'http://proxy:8080' });
        assert.strictEqual(manualWithUrl, 'Manual: http://proxy:8080');

        // Test Manual mode without URL
        const manualNotConfigured = i18nManager.t('statusbar.manualNotConfigured');
        assert.strictEqual(manualNotConfigured, 'Manual: 未設定');

        // Test Off mode
        const proxyOff = i18nManager.t('statusbar.proxyOff');
        assert.strictEqual(proxyOff, 'Proxy: Off');
    });

    test('Status bar tooltip should be localized in English', () => {
        // Initialize with English
        i18nManager.initialize('en');

        // Test tooltip title
        const title = i18nManager.t('statusbar.tooltip.title');
        assert.strictEqual(title, 'Proxy Configuration');

        // Test tooltip fields
        const currentMode = i18nManager.t('statusbar.tooltip.currentMode');
        assert.strictEqual(currentMode, 'Current Mode');

        const status = i18nManager.t('statusbar.tooltip.status');
        assert.strictEqual(status, 'Status');

        const lastCheck = i18nManager.t('statusbar.tooltip.lastCheck');
        assert.strictEqual(lastCheck, 'Last Check');

        const detectionSource = i18nManager.t('statusbar.tooltip.detectionSource');
        assert.strictEqual(detectionSource, 'Detection Source');

        const lastError = i18nManager.t('statusbar.tooltip.lastError');
        assert.strictEqual(lastError, 'Last Error');

        const consecutiveFailures = i18nManager.t('statusbar.tooltip.consecutiveFailures');
        assert.strictEqual(consecutiveFailures, 'Consecutive Failures');

        const manualProxy = i18nManager.t('statusbar.tooltip.manualProxy');
        assert.strictEqual(manualProxy, 'Manual Proxy');

        const systemProxy = i18nManager.t('statusbar.tooltip.systemProxy');
        assert.strictEqual(systemProxy, 'System Proxy');
    });

    test('Status bar tooltip should be localized in Japanese', () => {
        // Initialize with Japanese
        i18nManager.initialize('ja');

        // Test tooltip title
        const title = i18nManager.t('statusbar.tooltip.title');
        assert.strictEqual(title, 'Proxy設定');

        // Test tooltip fields
        const currentMode = i18nManager.t('statusbar.tooltip.currentMode');
        assert.strictEqual(currentMode, '現在のモード');

        const status = i18nManager.t('statusbar.tooltip.status');
        assert.strictEqual(status, 'ステータス');

        const lastCheck = i18nManager.t('statusbar.tooltip.lastCheck');
        assert.strictEqual(lastCheck, '最終チェック');

        const detectionSource = i18nManager.t('statusbar.tooltip.detectionSource');
        assert.strictEqual(detectionSource, '検出ソース');

        const lastError = i18nManager.t('statusbar.tooltip.lastError');
        assert.strictEqual(lastError, '最後のエラー');

        const consecutiveFailures = i18nManager.t('statusbar.tooltip.consecutiveFailures');
        assert.strictEqual(consecutiveFailures, '連続失敗回数');

        const manualProxy = i18nManager.t('statusbar.tooltip.manualProxy');
        assert.strictEqual(manualProxy, '手動Proxy');

        const systemProxy = i18nManager.t('statusbar.tooltip.systemProxy');
        assert.strictEqual(systemProxy, 'システムProxy');
    });

    test('Status bar tooltip status messages should be localized in English', () => {
        // Initialize with English
        i18nManager.initialize('en');

        // Test Auto mode status messages
        const autoModeUsing = i18nManager.t('statusbar.tooltip.autoModeUsing', { url: 'http://proxy:8080' });
        assert.strictEqual(autoModeUsing, 'Auto Mode - Using system proxy: http://proxy:8080');

        const autoModeNoProxy = i18nManager.t('statusbar.tooltip.autoModeNoProxy');
        assert.strictEqual(autoModeNoProxy, 'Auto Mode - No system proxy detected');

        // Test Manual mode status messages
        const manualModeUsing = i18nManager.t('statusbar.tooltip.manualModeUsing', { url: 'http://proxy:8080' });
        assert.strictEqual(manualModeUsing, 'Manual Mode - Using: http://proxy:8080');

        const manualModeNotConfigured = i18nManager.t('statusbar.tooltip.manualModeNotConfigured');
        assert.strictEqual(manualModeNotConfigured, 'Manual Mode - No proxy configured');

        // Test Off mode status message
        const proxyDisabled = i18nManager.t('statusbar.tooltip.proxyDisabled');
        assert.strictEqual(proxyDisabled, 'Proxy disabled');
    });

    test('Status bar tooltip status messages should be localized in Japanese', () => {
        // Initialize with Japanese
        i18nManager.initialize('ja');

        // Test Auto mode status messages
        const autoModeUsing = i18nManager.t('statusbar.tooltip.autoModeUsing', { url: 'http://proxy:8080' });
        assert.strictEqual(autoModeUsing, 'Autoモード - システムproxyを使用中: http://proxy:8080');

        const autoModeNoProxy = i18nManager.t('statusbar.tooltip.autoModeNoProxy');
        assert.strictEqual(autoModeNoProxy, 'Autoモード - システムproxyが検出されていません');

        // Test Manual mode status messages
        const manualModeUsing = i18nManager.t('statusbar.tooltip.manualModeUsing', { url: 'http://proxy:8080' });
        assert.strictEqual(manualModeUsing, 'Manualモード - 使用中: http://proxy:8080');

        const manualModeNotConfigured = i18nManager.t('statusbar.tooltip.manualModeNotConfigured');
        assert.strictEqual(manualModeNotConfigured, 'Manualモード - Proxyが設定されていません');

        // Test Off mode status message
        const proxyDisabled = i18nManager.t('statusbar.tooltip.proxyDisabled');
        assert.strictEqual(proxyDisabled, 'Proxyが無効');
    });

    test('Status bar command links should be localized in English', () => {
        // Initialize with English
        i18nManager.initialize('en');

        // Test command link labels
        const toggleMode = i18nManager.t('statusbar.link.toggleMode');
        assert.strictEqual(toggleMode, 'Toggle Mode');

        const configureManual = i18nManager.t('statusbar.link.configureManual');
        assert.strictEqual(configureManual, 'Configure Manual');

        const importSystem = i18nManager.t('statusbar.link.importSystem');
        assert.strictEqual(importSystem, 'Import System');

        const testProxy = i18nManager.t('statusbar.link.testProxy');
        assert.strictEqual(testProxy, 'Test Proxy');
    });

    test('Status bar command links should be localized in Japanese', () => {
        // Initialize with Japanese
        i18nManager.initialize('ja');

        // Test command link labels
        const toggleMode = i18nManager.t('statusbar.link.toggleMode');
        assert.strictEqual(toggleMode, 'モードを切り替え');

        const configureManual = i18nManager.t('statusbar.link.configureManual');
        assert.strictEqual(configureManual, '手動設定');

        const importSystem = i18nManager.t('statusbar.link.importSystem');
        assert.strictEqual(importSystem, 'システムからインポート');

        const testProxy = i18nManager.t('statusbar.link.testProxy');
        assert.strictEqual(testProxy, 'Proxyをテスト');
    });
});
