import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { UserNotifier } from '../../errors/UserNotifier';
import { I18nManager } from '../../i18n/I18nManager';

suite('UserNotifier Tests', () => {
    let userNotifier: UserNotifier;
    let i18n: I18nManager;
    let sandbox: sinon.SinonSandbox;
    let showErrorMessageStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        i18n.initialize('en'); // Initialize with English for tests
        
        userNotifier = new UserNotifier();

        // Stub VSCode window methods
        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('showSuccess should display translated message for English', () => {
        userNotifier.showSuccess('message.proxyDisabled');

        assert.ok(showInformationMessageStub.calledOnce);
        const message = showInformationMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Proxy disabled');
    });

    test('showSuccess should display translated message with parameters', () => {
        userNotifier.showSuccess('message.proxyConfigured', { url: 'http://test:8080' });

        assert.ok(showInformationMessageStub.calledOnce);
        const message = showInformationMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Proxy configured: http://test:8080');
    });

    test('showWarning should display translated message for English', () => {
        userNotifier.showWarning('warning.noSystemProxyDetected');

        assert.ok(showWarningMessageStub.calledOnce);
        const message = showWarningMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'No system proxy detected. Switching to Off mode.');
    });

    test('showError should display translated message for English', () => {
        userNotifier.showError('error.invalidProxyUrl');

        assert.ok(showErrorMessageStub.calledOnce);
        const message = showErrorMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Invalid proxy URL format');
    });

    test('showError should display translated message with suggestions', () => {
        userNotifier.showError('error.invalidProxyUrl', [
            'suggestion.useFormat',
            'suggestion.includeProtocol'
        ]);

        assert.ok(showErrorMessageStub.calledOnce);
        const message = showErrorMessageStub.firstCall.args[0];
        assert.ok(message.includes('Invalid proxy URL format'));
        assert.ok(message.includes('Suggestions:'));
        assert.ok(message.includes('Use format: http://proxy.example.com:8080'));
        assert.ok(message.includes('Include protocol (http:// or https://)'));
    });

    test('showSuccess should work with direct text for backward compatibility', () => {
        userNotifier.showSuccess('Direct success message');

        assert.ok(showInformationMessageStub.calledOnce);
        const message = showInformationMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Direct success message');
    });

    test('showWarning should work with direct text for backward compatibility', () => {
        userNotifier.showWarning('Direct warning message');

        assert.ok(showWarningMessageStub.calledOnce);
        const message = showWarningMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Direct warning message');
    });

    test('showError should work with direct text for backward compatibility', () => {
        userNotifier.showError('Direct error message', ['Suggestion 1', 'Suggestion 2']);

        assert.ok(showErrorMessageStub.calledOnce);
        const message = showErrorMessageStub.firstCall.args[0];
        assert.ok(message.includes('Direct error message'));
        assert.ok(message.includes('Suggestion 1'));
        assert.ok(message.includes('Suggestion 2'));
    });

    test('Messages should be in Japanese when locale is ja', () => {
        i18n.initialize('ja');
        const jaNotifier = new UserNotifier();

        jaNotifier.showSuccess('message.proxyDisabled');

        assert.ok(showInformationMessageStub.calledOnce);
        const message = showInformationMessageStub.firstCall.args[0];
        assert.strictEqual(message, 'Proxyが無効化されました');
    });
});
