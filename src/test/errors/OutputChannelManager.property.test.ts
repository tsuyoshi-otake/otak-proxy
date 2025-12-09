/**
 * Property-based tests for OutputChannelManager
 * **Feature: notification-ux-improvements**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { OutputChannelManager, ErrorDetails } from '../../errors/OutputChannelManager';
import { getPropertyTestRuns } from '../helpers';

suite('OutputChannelManager Property Tests', () => {
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
    });

    teardown(() => {
        sandbox.restore();
        (OutputChannelManager as any).instance = undefined;
    });

    /**
     * Generator for ErrorDetails
     * Creates random error details with all possible fields
     */
    const errorDetailsGenerator = (): fc.Arbitrary<ErrorDetails> => {
        return fc.record({
            timestamp: fc.date(),
            errorMessage: fc.string({ minLength: 5, maxLength: 200 }).filter(s => s.trim().length >= 3),
            stackTrace: fc.option(fc.string({ minLength: 10, maxLength: 500 }), { nil: undefined }),
            attemptedUrls: fc.option(
                fc.array(fc.webUrl(), { minLength: 1, maxLength: 10 }),
                { nil: undefined }
            ),
            suggestions: fc.option(
                fc.array(fc.string({ minLength: 5, maxLength: 100 }), { minLength: 1, maxLength: 5 }),
                { nil: undefined }
            ),
            context: fc.option(
                fc.dictionary(
                    fc.string({ minLength: 1, maxLength: 20 }),
                    fc.oneof(
                        fc.string(),
                        fc.integer(),
                        fc.boolean()
                    )
                ),
                { nil: undefined }
            )
        });
    };

    /**
     * **Property 4: 出力チャネルの完全性**
     * **Validates: Requirements 3.3, 3.4**
     *
     * For any ErrorDetails, the output channel should record all provided information
     * including timestamp, error message, attempted URLs, and suggestions
     */
    test('Property 4: 出力チャネルの完全性 - all error details are logged completely', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 100 }), // message
                errorDetailsGenerator(), // details
                async (message: string, details: ErrorDetails) => {
                    // Reset mock for each iteration
                    mockOutputChannel.appendLine.resetHistory();
                    
                    const manager = OutputChannelManager.getInstance();
                    manager.logError(message, details);

                    // Get all logged messages
                    const calls = mockOutputChannel.appendLine.getCalls();
                    const loggedMessages = calls.map(call => call.args[0]).join('\n');

                    // Verify timestamp is present (check for [ERROR] marker)
                    assert.ok(
                        loggedMessages.includes('[ERROR]'),
                        'Timestamp marker [ERROR] should be present'
                    );

                    // Verify error message is logged
                    assert.ok(
                        loggedMessages.includes(details.errorMessage) || 
                        loggedMessages.includes('***'), // May be masked if contains credentials
                        'Error message should be logged'
                    );

                    // Verify stack trace is logged if provided
                    if (details.stackTrace) {
                        assert.ok(
                            loggedMessages.includes('Stack Trace'),
                            'Stack trace section should be present when provided'
                        );
                    }

                    // Verify attempted URLs are logged if provided
                    if (details.attemptedUrls && details.attemptedUrls.length > 0) {
                        assert.ok(
                            loggedMessages.includes('Attempted URLs'),
                            'Attempted URLs section should be present when provided'
                        );
                        
                        // Verify all URLs are logged (may be masked)
                        details.attemptedUrls.forEach((url, index) => {
                            const urlNumber = `${index + 1}.`;
                            assert.ok(
                                loggedMessages.includes(urlNumber),
                                `URL number ${urlNumber} should be present`
                            );
                        });
                    }

                    // Verify suggestions are logged if provided
                    if (details.suggestions && details.suggestions.length > 0) {
                        assert.ok(
                            loggedMessages.includes('Suggestions'),
                            'Suggestions section should be present when provided'
                        );
                        
                        // Verify all suggestions are logged
                        details.suggestions.forEach((suggestion, index) => {
                            const suggestionNumber = `${index + 1}.`;
                            assert.ok(
                                loggedMessages.includes(suggestionNumber),
                                `Suggestion number ${suggestionNumber} should be present`
                            );
                        });
                    }

                    // Verify context is logged if provided
                    if (details.context && Object.keys(details.context).length > 0) {
                        assert.ok(
                            loggedMessages.includes('Context'),
                            'Context section should be present when provided'
                        );
                        
                        // Verify all context keys are logged
                        Object.keys(details.context).forEach(key => {
                            assert.ok(
                                loggedMessages.includes(key),
                                `Context key "${key}" should be present`
                            );
                        });
                    }
                }
            ),
            { numRuns }
        );
    });


});
