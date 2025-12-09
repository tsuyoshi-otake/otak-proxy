import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { OutputChannelManager, ErrorDetails } from '../../errors/OutputChannelManager';

suite('OutputChannelManager Tests', () => {
    let outputChannelManager: OutputChannelManager;
    let sandbox: sinon.SinonSandbox;
    let mockOutputChannel: {
        appendLine: sinon.SinonStub;
        show: sinon.SinonStub;
        clear: sinon.SinonStub;
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        
        // Create mock output channel
        mockOutputChannel = {
            appendLine: sandbox.stub(),
            show: sandbox.stub(),
            clear: sandbox.stub()
        };

        // Stub vscode.window.createOutputChannel
        sandbox.stub(vscode.window, 'createOutputChannel').returns(mockOutputChannel as any);
        
        // Reset singleton instance for testing
        (OutputChannelManager as any).instance = undefined;
        outputChannelManager = OutputChannelManager.getInstance();
    });

    teardown(() => {
        sandbox.restore();
        (OutputChannelManager as any).instance = undefined;
    });

    test('getInstance should return singleton instance', () => {
        const instance1 = OutputChannelManager.getInstance();
        const instance2 = OutputChannelManager.getInstance();
        
        assert.strictEqual(instance1, instance2);
    });

    test('logError should record error message with timestamp', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Test error'
        };

        outputChannelManager.logError('Error occurred', details);

        assert.ok(mockOutputChannel.appendLine.called);
        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        // Check that error message is logged
        assert.ok(messages.some(msg => msg.includes('Error occurred')));
        assert.ok(messages.some(msg => msg.includes('Test error')));
        assert.ok(messages.some(msg => msg.includes('[ERROR]')));
    });

    test('logError should include stack trace when provided', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Test error',
            stackTrace: 'Error: Test\n  at test.ts:10'
        };

        outputChannelManager.logError('Error with stack', details);

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Stack Trace')));
        assert.ok(messages.some(msg => msg.includes('Error: Test')));
    });

    test('logError should include attempted URLs when provided', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Connection failed',
            attemptedUrls: ['http://proxy1:8080', 'http://proxy2:8080']
        };

        outputChannelManager.logError('Failed to connect', details);

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Attempted URLs')));
        assert.ok(messages.some(msg => msg.includes('proxy1')));
        assert.ok(messages.some(msg => msg.includes('proxy2')));
    });

    test('logError should include suggestions when provided', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Invalid URL',
            suggestions: ['Check URL format', 'Verify proxy settings']
        };

        outputChannelManager.logError('URL error', details);

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Suggestions')));
        assert.ok(messages.some(msg => msg.includes('Check URL format')));
        assert.ok(messages.some(msg => msg.includes('Verify proxy settings')));
    });

    test('logError should include context when provided', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Test error',
            context: {
                mode: 'auto',
                retryCount: 3
            }
        };

        outputChannelManager.logError('Error with context', details);

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Context')));
        assert.ok(messages.some(msg => msg.includes('mode')));
        assert.ok(messages.some(msg => msg.includes('auto')));
    });

    test('logError should mask passwords in URLs', () => {
        const details: ErrorDetails = {
            timestamp: new Date(),
            errorMessage: 'Connection failed',
            attemptedUrls: ['http://user:password@proxy:8080']
        };

        outputChannelManager.logError('Failed to connect', details);

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        // Password should be masked
        assert.ok(!messages.some(msg => msg.includes('password')));
        assert.ok(messages.some(msg => msg.includes('***')));
    });

    test('logInfo should record informational message', () => {
        outputChannelManager.logInfo('Test info message');

        assert.ok(mockOutputChannel.appendLine.called);
        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('[INFO]')));
        assert.ok(messages.some(msg => msg.includes('Test info message')));
    });

    test('logInfo should include details when provided', () => {
        outputChannelManager.logInfo('Info with details', { key: 'value' });

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Details')));
    });

    test('logWarning should record warning message', () => {
        outputChannelManager.logWarning('Test warning message');

        assert.ok(mockOutputChannel.appendLine.called);
        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('[WARNING]')));
        assert.ok(messages.some(msg => msg.includes('Test warning message')));
    });

    test('logWarning should include details when provided', () => {
        outputChannelManager.logWarning('Warning with details', { reason: 'timeout' });

        const calls = mockOutputChannel.appendLine.getCalls();
        const messages = calls.map(call => call.args[0]);
        
        assert.ok(messages.some(msg => msg.includes('Details')));
    });

    test('show should display output channel', () => {
        outputChannelManager.show();

        assert.ok(mockOutputChannel.show.calledOnce);
    });

    test('clear should clear output channel', () => {
        outputChannelManager.clear();

        assert.ok(mockOutputChannel.clear.calledOnce);
    });
});
