import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { UserNotifier } from '../../errors/UserNotifier';
import { I18nManager } from '../../i18n/I18nManager';
import { OutputChannelManager } from '../../errors/OutputChannelManager';

suite('UserNotifier Tests', () => {
    let userNotifier: UserNotifier;
    let i18n: I18nManager;
    let sandbox: sinon.SinonSandbox;
    let showErrorMessageStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;
    let setStatusBarMessageStub: sinon.SinonStub;
    let withProgressStub: sinon.SinonStub;
    let outputManagerShowStub: sinon.SinonStub;
    let outputManagerLogErrorStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        i18n.initialize('en'); // Initialize with English for tests
        
        userNotifier = new UserNotifier();

        // Stub VSCode window methods
        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');
        setStatusBarMessageStub = sandbox.stub(vscode.window, 'setStatusBarMessage').returns({ dispose: () => {} } as any);
        withProgressStub = sandbox.stub(vscode.window, 'withProgress');
        
        // Stub OutputChannelManager methods
        const outputManager = OutputChannelManager.getInstance();
        outputManagerShowStub = sandbox.stub(outputManager, 'show');
        outputManagerLogErrorStub = sandbox.stub(outputManager, 'logError');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('showSuccess should display translated message for English', () => {
        userNotifier.showSuccess('message.proxyDisabled');

        assert.ok(setStatusBarMessageStub.calledOnce);
        const message = setStatusBarMessageStub.firstCall.args[0] as string;
        assert.ok(message.includes('Proxy disabled'));
        assert.strictEqual(setStatusBarMessageStub.firstCall.args[1], 3000);
    });

    test('showSuccess should display translated message with parameters', () => {
        userNotifier.showSuccess('message.proxyConfigured', { url: 'http://test:8080' });

        assert.ok(setStatusBarMessageStub.calledOnce);
        const message = setStatusBarMessageStub.firstCall.args[0] as string;
        assert.ok(message.includes('Proxy configured: http://test:8080'));
        assert.strictEqual(setStatusBarMessageStub.firstCall.args[1], 3000);
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

        assert.ok(setStatusBarMessageStub.calledOnce);
        const message = setStatusBarMessageStub.firstCall.args[0] as string;
        assert.ok(message.includes('Direct success message'));
        assert.strictEqual(setStatusBarMessageStub.firstCall.args[1], 3000);
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

        assert.ok(setStatusBarMessageStub.calledOnce);
        const message = setStatusBarMessageStub.firstCall.args[0] as string;
        assert.ok(message.includes('Proxyが無効化されました'));
        assert.strictEqual(setStatusBarMessageStub.firstCall.args[1], 3000);
    });

    suite('Enhanced Features Tests', () => {
        test('showErrorWithDetails should log to output channel and show error with details button', async () => {
            showErrorMessageStub.resolves(undefined);
            
            await userNotifier.showErrorWithDetails(
                'Test error message',
                {
                    timestamp: new Date(),
                    errorMessage: 'Detailed error',
                    attemptedUrls: ['http://proxy1:8080', 'http://proxy2:8080']
                },
                ['Suggestion 1', 'Suggestion 2']
            );

            // Should log to output channel
            assert.ok(outputManagerLogErrorStub.calledOnce);
            const logCall = outputManagerLogErrorStub.firstCall.args;
            assert.strictEqual(logCall[0], 'Test error message');
            assert.ok(logCall[1].suggestions);
            assert.strictEqual(logCall[1].suggestions.length, 2);

            // Should show error message with Show Details button
            assert.ok(showErrorMessageStub.calledOnce);
            const errorCall = showErrorMessageStub.firstCall.args;
            assert.ok(errorCall[0].includes('Test error message'));
            assert.strictEqual(errorCall[1], 'Show Details');
        });

        test('showErrorWithDetails should open output channel when Show Details is clicked', async () => {
            showErrorMessageStub.resolves('Show Details');
            
            await userNotifier.showErrorWithDetails(
                'Test error',
                {
                    timestamp: new Date(),
                    errorMessage: 'Error details'
                }
            );

            // Should open output channel
            assert.ok(outputManagerShowStub.calledOnce);
        });

        test('showErrorWithDetails should apply message formatting', async () => {
            showErrorMessageStub.resolves(undefined);
            
            const longMessage = 'A'.repeat(250); // Message longer than 200 chars
            await userNotifier.showErrorWithDetails(
                longMessage,
                {
                    timestamp: new Date(),
                    errorMessage: 'Error'
                }
            );

            // Message should be truncated
            const displayedMessage = showErrorMessageStub.firstCall.args[0];
            assert.ok(displayedMessage.length <= 203); // 200 + '...'
        });

        test('showErrorWithDetails should summarize suggestions', async () => {
            showErrorMessageStub.resolves(undefined);
            
            const suggestions = ['Suggestion 1', 'Suggestion 2', 'Suggestion 3', 'Suggestion 4', 'Suggestion 5'];
            await userNotifier.showErrorWithDetails(
                'Error',
                {
                    timestamp: new Date(),
                    errorMessage: 'Error'
                },
                suggestions
            );

            const displayedMessage = showErrorMessageStub.firstCall.args[0];
            // Should only show first 3 suggestions
            assert.ok(displayedMessage.includes('Suggestion 1'));
            assert.ok(displayedMessage.includes('Suggestion 2'));
            assert.ok(displayedMessage.includes('Suggestion 3'));
            assert.ok(!displayedMessage.includes('Suggestion 4'));
        });

        test('showErrorWithDetails should respect throttling', async () => {
            showErrorMessageStub.resolves(undefined);
            
            // First call should show
            await userNotifier.showErrorWithDetails(
                'error.test',
                {
                    timestamp: new Date(),
                    errorMessage: 'Error'
                }
            );
            assert.strictEqual(showErrorMessageStub.callCount, 1);

            // Second call within throttle window should not show but still log
            await userNotifier.showErrorWithDetails(
                'error.test',
                {
                    timestamp: new Date(),
                    errorMessage: 'Error'
                }
            );
            assert.strictEqual(showErrorMessageStub.callCount, 1); // Still 1
            assert.strictEqual(outputManagerLogErrorStub.callCount, 2); // But logged twice
        });

        test('showProgressNotification should call withProgress', async () => {
            const mockTask = async (progress: vscode.Progress<any>) => {
                progress.report({ message: 'Working...' });
                return 'result';
            };
            
            withProgressStub.callsFake(async (options, task) => {
                return await task({ report: () => {} }, {} as any);
            });

            const result = await userNotifier.showProgressNotification(
                'Test Progress',
                mockTask,
                true
            );

            assert.ok(withProgressStub.calledOnce);
            const progressOptions = withProgressStub.firstCall.args[0];
            assert.strictEqual(progressOptions.title, 'Test Progress');
            assert.strictEqual(progressOptions.cancellable, true);
            assert.strictEqual(progressOptions.location, vscode.ProgressLocation.Notification);
            assert.strictEqual(result, 'result');
        });

        test('showError should apply message formatting', () => {
            const longMessage = 'B'.repeat(250);
            userNotifier.showError(longMessage);

            const displayedMessage = showErrorMessageStub.firstCall.args[0];
            assert.ok(displayedMessage.length <= 203); // 200 + '...'
        });

        test('showError should respect throttling', () => {
            userNotifier.showError('error.duplicate');
            assert.strictEqual(showErrorMessageStub.callCount, 1);

            // Second call within throttle window should not show
            userNotifier.showError('error.duplicate');
            assert.strictEqual(showErrorMessageStub.callCount, 1);
        });

        test('showError should still log throttled errors to output channel', () => {
            userNotifier.showError('error.throttled', ['Suggestion']);
            assert.strictEqual(outputManagerLogErrorStub.callCount, 0); // First call doesn't log

            // Second call should log even if throttled
            userNotifier.showError('error.throttled', ['Suggestion']);
            assert.strictEqual(outputManagerLogErrorStub.callCount, 1);
        });
    });
});
