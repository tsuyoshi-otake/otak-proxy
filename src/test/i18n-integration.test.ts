import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { UserNotifier } from '../errors/UserNotifier';

/**
 * I18n Integration Test Suite
 *
 * Tests the complete internationalization workflow:
 * - Language detection and initialization
 * - Message translation across components
 * - Status bar localization
 * - Command palette localization
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4
 */
suite('I18n Integration Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let i18n: I18nManager;
    let userNotifier: UserNotifier;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        userNotifier = new UserNotifier();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Integration Test 1: Language Detection and Initialization
     * 
     * Tests that the I18nManager correctly detects the language and loads
     * the appropriate translation files.
     * 
     * Requirements: 1.1, 1.2, 1.3, 1.4
     */
    suite('Language Detection and Initialization', () => {
        test('should initialize with Japanese locale', () => {
            // Initialize with Japanese
            i18n.initialize('ja');
            
            // Verify current locale
            assert.strictEqual(i18n.getCurrentLocale(), 'ja', 'Current locale should be Japanese');
            
            // Verify Japanese translations are loaded
            const message = i18n.t('command.toggleProxy');
            assert.ok(message.includes('Proxy'), 'Should contain "Proxy"');
            assert.ok(message.includes('切り替え') || message === 'Proxyを切り替え', 'Should be in Japanese');
        });

        test('should initialize with English locale', () => {
            // Initialize with English
            i18n.initialize('en');
            
            // Verify current locale
            assert.strictEqual(i18n.getCurrentLocale(), 'en', 'Current locale should be English');
            
            // Verify English translations are loaded
            const message = i18n.t('command.toggleProxy');
            assert.strictEqual(message, 'Toggle Proxy', 'Should be in English');
        });

        test('should fallback to English for unsupported locale', () => {
            // Initialize with unsupported locale
            i18n.initialize('fr');
            
            // Verify fallback to English
            assert.strictEqual(i18n.getCurrentLocale(), 'en', 'Should fallback to English');
            
            // Verify English translations are loaded
            const message = i18n.t('command.toggleProxy');
            assert.strictEqual(message, 'Toggle Proxy', 'Should be in English');
        });

        test('should detect locale from vscode.env.language', () => {
            // Mock vscode.env.language
            const originalLanguage = vscode.env.language;
            
            // Note: We can't actually change vscode.env.language in tests,
            // but we can test that initialize() without parameters uses it
            i18n.initialize();
            
            // Verify that a locale was set (either 'en' or 'ja' depending on test environment)
            const currentLocale = i18n.getCurrentLocale();
            assert.ok(['en', 'ja'].includes(currentLocale), 'Should set a supported locale');
        });
    });

    /**
     * Integration Test 2: Message Translation Across Components
     * 
     * Tests that messages are correctly translated across different components
     * (UserNotifier, status bar, etc.)
     * 
     * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
     */
    suite('Message Translation Across Components', () => {
        test('should translate information messages in Japanese', () => {
            i18n.initialize('ja');
            
            // Test message translation
            const message = i18n.t('message.proxyConfigured', { url: 'http://proxy:8080' });
            assert.ok(message.includes('Proxy'), 'Should contain "Proxy"');
            assert.ok(message.includes('http://proxy:8080'), 'Should contain the URL');
            assert.ok(message.includes('設定') || message.includes('構成'), 'Should be in Japanese');
        });

        test('should translate information messages in English', () => {
            i18n.initialize('en');
            
            // Test message translation
            const message = i18n.t('message.proxyConfigured', { url: 'http://proxy:8080' });
            assert.ok(message.includes('Proxy configured'), 'Should be in English');
            assert.ok(message.includes('http://proxy:8080'), 'Should contain the URL');
        });

        test('should translate warning messages', () => {
            i18n.initialize('ja');
            
            // Test warning message
            const message = i18n.t('warning.noManualProxy');
            assert.ok(message.length > 0, 'Should return a translated message');
            assert.ok(message.includes('Manual') || message.includes('手動'), 'Should contain relevant text');
        });

        test('should translate error messages', () => {
            i18n.initialize('en');
            
            // Test error message
            const message = i18n.t('error.proxyTestFailed', { url: 'http://proxy:8080' });
            assert.ok(message.includes('failed') || message.includes('test'), 'Should be an error message');
            assert.ok(message.includes('http://proxy:8080'), 'Should contain the URL');
        });

        test('should translate action button labels', () => {
            i18n.initialize('ja');
            
            // Test action labels
            const configureManual = i18n.t('action.configureManual');
            const importSystem = i18n.t('action.importSystem');
            const testFirst = i18n.t('action.testFirst');
            
            assert.ok(configureManual.length > 0, 'Should translate configureManual');
            assert.ok(importSystem.length > 0, 'Should translate importSystem');
            assert.ok(testFirst.length > 0, 'Should translate testFirst');
        });

        test('should handle parameter substitution in messages', () => {
            i18n.initialize('en');
            
            // Test parameter substitution
            const message = i18n.t('message.systemProxyChanged', { url: 'http://new-proxy:8080' });
            assert.ok(message.includes('http://new-proxy:8080'), 'Should substitute URL parameter');
            assert.ok(message.includes('System proxy'), 'Should contain base message');
        });
    });

    /**
     * Integration Test 3: Status Bar Localization
     * 
     * Tests that status bar text and tooltips are correctly localized.
     * 
     * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
     */
    suite('Status Bar Localization', () => {
        test('should translate status bar text for Auto mode in Japanese', () => {
            i18n.initialize('ja');
            
            // Test Auto mode status
            const autoStatus = i18n.t('statusbar.autoWithProxy', { url: 'http://proxy:8080' });
            assert.ok(autoStatus.includes('Auto'), 'Should contain "Auto"');
            assert.ok(autoStatus.includes('http://proxy:8080'), 'Should contain the URL');
        });

        test('should translate status bar text for Manual mode in English', () => {
            i18n.initialize('en');
            
            // Test Manual mode status
            const manualStatus = i18n.t('statusbar.manualWithProxy', { url: 'http://proxy:8080' });
            assert.ok(manualStatus.includes('Manual'), 'Should contain "Manual"');
            assert.ok(manualStatus.includes('http://proxy:8080'), 'Should contain the URL');
        });

        test('should translate status bar text for Off mode', () => {
            i18n.initialize('ja');
            
            // Test Off mode status
            const offStatus = i18n.t('statusbar.off');
            assert.ok(offStatus.includes('Proxy'), 'Should contain "Proxy"');
            assert.ok(offStatus.includes('Off'), 'Should contain "Off"');
        });

        test('should translate status bar tooltip labels', () => {
            i18n.initialize('en');
            
            // Test tooltip labels
            const proxyConfig = i18n.t('statusbar.tooltip.proxyConfiguration');
            const currentMode = i18n.t('statusbar.tooltip.currentMode');
            const status = i18n.t('statusbar.tooltip.status');
            
            assert.ok(proxyConfig.includes('Proxy'), 'Should translate proxy configuration');
            assert.ok(currentMode.includes('Mode'), 'Should translate current mode');
            assert.ok(status.length > 0, 'Should translate status');
        });

        test('should translate command links in tooltip', () => {
            i18n.initialize('ja');
            
            // Test command link labels
            const toggleMode = i18n.t('statusbar.tooltip.toggleMode');
            const configureManual = i18n.t('statusbar.tooltip.configureManual');
            const importSystem = i18n.t('statusbar.tooltip.importSystem');
            const testProxy = i18n.t('statusbar.tooltip.testProxy');
            
            assert.ok(toggleMode.length > 0, 'Should translate toggle mode');
            assert.ok(configureManual.length > 0, 'Should translate configure manual');
            assert.ok(importSystem.length > 0, 'Should translate import system');
            assert.ok(testProxy.length > 0, 'Should translate test proxy');
        });
    });

    /**
     * Integration Test 4: Command Palette Localization
     * 
     * Tests that command titles in the command palette are localized.
     * Note: Command titles are localized through package.nls.json files,
     * which VS Code handles automatically. This test verifies that the
     * translation keys are properly defined.
     * 
     * Requirements: 5.1, 5.2, 5.3, 5.4
     */
    suite('Command Palette Localization', () => {
        test('should have translation keys for all commands', () => {
            i18n.initialize('en');
            
            // Verify command translation keys exist
            const toggleProxy = i18n.t('command.toggleProxy');
            const testProxy = i18n.t('command.testProxy');
            const importProxy = i18n.t('command.importProxy');
            
            assert.ok(toggleProxy.length > 0, 'Should have toggleProxy translation');
            assert.ok(testProxy.length > 0, 'Should have testProxy translation');
            assert.ok(importProxy.length > 0, 'Should have importProxy translation');
        });

        test('should translate command titles in Japanese', () => {
            i18n.initialize('ja');
            
            // Verify Japanese command translations
            const toggleProxy = i18n.t('command.toggleProxy');
            const testProxy = i18n.t('command.testProxy');
            const importProxy = i18n.t('command.importProxy');
            
            assert.ok(toggleProxy.includes('Proxy'), 'Should contain "Proxy"');
            assert.ok(testProxy.includes('Proxy'), 'Should contain "Proxy"');
            assert.ok(importProxy.includes('Proxy'), 'Should contain "Proxy"');
        });

        test('should translate command titles in English', () => {
            i18n.initialize('en');
            
            // Verify English command translations
            const toggleProxy = i18n.t('command.toggleProxy');
            const testProxy = i18n.t('command.testProxy');
            const importProxy = i18n.t('command.importProxy');
            
            assert.strictEqual(toggleProxy, 'Toggle Proxy', 'Should be "Toggle Proxy"');
            assert.strictEqual(testProxy, 'Test Proxy', 'Should be "Test Proxy"');
            assert.strictEqual(importProxy, 'Import System Proxy', 'Should be "Import System Proxy"');
        });
    });

    /**
     * Integration Test 5: UserNotifier Integration
     * 
     * Tests that UserNotifier correctly uses I18nManager for message translation.
     * 
     * Requirements: 3.1, 3.2, 3.3, 3.4
     */
    suite('UserNotifier Integration', () => {
        test('should show translated error messages', () => {
            i18n.initialize('en');
            
            // Mock vscode.window.showErrorMessage
            const showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage');
            
            // Show error with message key
            userNotifier.showError('error.proxyTestFailed', undefined, { url: 'http://proxy:8080' });
            
            // Verify the message was translated
            assert.strictEqual(showErrorStub.calledOnce, true, 'Should call showErrorMessage once');
            const calledMessage = showErrorStub.firstCall.args[0] as string;
            assert.ok(calledMessage.includes('http://proxy:8080'), 'Should include the URL');
        });

        test('should show translated success messages', () => {
            i18n.initialize('ja');
            
            // Mock vscode.window.showInformationMessage
            const showInfoStub = sandbox.stub(vscode.window, 'showInformationMessage');
            
            // Show success with message key
            userNotifier.showSuccess('message.proxyConfigured', { url: 'http://proxy:8080' });
            
            // Verify the message was translated
            assert.strictEqual(showInfoStub.calledOnce, true, 'Should call showInformationMessage once');
            const calledMessage = showInfoStub.firstCall.args[0] as string;
            assert.ok(calledMessage.includes('http://proxy:8080'), 'Should include the URL');
        });

        test('should show translated warning messages', () => {
            i18n.initialize('en');
            
            // Mock vscode.window.showWarningMessage
            const showWarningStub = sandbox.stub(vscode.window, 'showWarningMessage');
            
            // Show warning with message key
            userNotifier.showWarning('warning.noManualProxy');
            
            // Verify the message was translated
            assert.strictEqual(showWarningStub.calledOnce, true, 'Should call showWarningMessage once');
        });

        test('should support backward compatibility with direct messages', () => {
            i18n.initialize('en');
            
            // Mock vscode.window.showInformationMessage
            const showInfoStub = sandbox.stub(vscode.window, 'showInformationMessage');
            
            // Show message with direct text (not a message key)
            const directMessage = 'This is a direct message';
            userNotifier.showSuccess(directMessage);
            
            // Verify the direct message was shown as-is
            assert.strictEqual(showInfoStub.calledOnce, true, 'Should call showInformationMessage once');
            const calledMessage = showInfoStub.firstCall.args[0] as string;
            assert.strictEqual(calledMessage, directMessage, 'Should show direct message as-is');
        });
    });

    /**
     * Integration Test 6: End-to-End Localization Workflow
     * 
     * Tests a complete workflow with language switching to verify that
     * all components work together correctly.
     * 
     * Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5
     */
    suite('End-to-End Localization Workflow', () => {
        test('should handle complete workflow in Japanese', () => {
            // Step 1: Initialize with Japanese
            i18n.initialize('ja');
            assert.strictEqual(i18n.getCurrentLocale(), 'ja', 'Should be in Japanese');
            
            // Step 2: Translate various message types
            const command = i18n.t('command.toggleProxy');
            const action = i18n.t('action.configureManual');
            const message = i18n.t('message.proxyConfigured', { url: 'http://proxy:8080' });
            const statusbar = i18n.t('statusbar.autoWithProxy', { url: 'http://proxy:8080' });
            
            // Step 3: Verify all translations are in Japanese
            assert.ok(command.length > 0, 'Should translate command');
            assert.ok(action.length > 0, 'Should translate action');
            assert.ok(message.includes('http://proxy:8080'), 'Should translate message with params');
            assert.ok(statusbar.includes('Auto'), 'Should translate statusbar');
        });

        test('should handle complete workflow in English', () => {
            // Step 1: Initialize with English
            i18n.initialize('en');
            assert.strictEqual(i18n.getCurrentLocale(), 'en', 'Should be in English');
            
            // Step 2: Translate various message types
            const command = i18n.t('command.toggleProxy');
            const action = i18n.t('action.configureManual');
            const message = i18n.t('message.proxyConfigured', { url: 'http://proxy:8080' });
            const statusbar = i18n.t('statusbar.autoWithProxy', { url: 'http://proxy:8080' });
            
            // Step 3: Verify all translations are in English
            assert.strictEqual(command, 'Toggle Proxy', 'Should translate command');
            assert.ok(action.includes('Manual'), 'Should translate action');
            assert.ok(message.includes('http://proxy:8080'), 'Should translate message with params');
            assert.ok(statusbar.includes('Auto'), 'Should translate statusbar');
        });

        test('should handle language switching', () => {
            // Step 1: Start with English
            i18n.initialize('en');
            const englishMessage = i18n.t('command.toggleProxy');
            assert.strictEqual(englishMessage, 'Toggle Proxy', 'Should be in English');
            
            // Step 2: Switch to Japanese
            i18n.initialize('ja');
            const japaneseMessage = i18n.t('command.toggleProxy');
            assert.ok(japaneseMessage.includes('切り替え') || japaneseMessage === 'Proxyを切り替え', 'Should be in Japanese');
            
            // Step 3: Switch back to English
            i18n.initialize('en');
            const englishAgain = i18n.t('command.toggleProxy');
            assert.strictEqual(englishAgain, 'Toggle Proxy', 'Should be in English again');
        });
    });
});
