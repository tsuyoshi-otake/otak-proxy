import * as assert from 'assert';
import { ErrorAggregator } from '../errors/ErrorAggregator';

suite('ErrorAggregator Test Suite', () => {
    let aggregator: ErrorAggregator;

    setup(() => {
        aggregator = new ErrorAggregator();
    });

    suite('addError() and hasErrors()', () => {
        test('should start with no errors', () => {
            assert.strictEqual(aggregator.hasErrors(), false);
        });

        test('should have errors after adding one', () => {
            aggregator.addError('Git configuration', 'Git is not installed');
            assert.strictEqual(aggregator.hasErrors(), true);
        });

        test('should accumulate multiple errors', () => {
            aggregator.addError('Git configuration', 'Git is not installed');
            aggregator.addError('VSCode configuration', 'Permission denied');
            assert.strictEqual(aggregator.hasErrors(), true);
        });
    });

    suite('formatErrors()', () => {
        test('should return empty string when no errors', () => {
            const formatted = aggregator.formatErrors();
            assert.strictEqual(formatted, '');
        });

        test('should format single error with proper structure', () => {
            aggregator.addError('Git configuration', 'Git is not installed');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Operation failed: Git configuration'));
            assert.ok(formatted.includes('What happened:'));
            assert.ok(formatted.includes('Git configuration: Git is not installed'));
            assert.ok(formatted.includes('Suggestions:'));
        });

        test('should format multiple errors with count', () => {
            aggregator.addError('Git configuration', 'Git is not installed');
            aggregator.addError('VSCode configuration', 'Permission denied');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Multiple operations failed (2 errors)'));
            assert.ok(formatted.includes('What happened:'));
            assert.ok(formatted.includes('Git configuration: Git is not installed'));
            assert.ok(formatted.includes('VSCode configuration: Permission denied'));
            assert.ok(formatted.includes('Suggestions:'));
        });

        test('should include Git-specific suggestions for Git errors', () => {
            aggregator.addError('Git configuration', 'Git command not found');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Install Git from https://git-scm.com'));
            assert.ok(formatted.includes('Ensure Git is added to your system PATH'));
        });

        test('should include VSCode-specific suggestions for VSCode errors', () => {
            aggregator.addError('VSCode configuration', 'Failed to update settings');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Check VSCode settings permissions'));
            assert.ok(formatted.includes('Try restarting VSCode'));
        });

        test('should include connection suggestions for network errors', () => {
            aggregator.addError('Proxy test', 'Connection timeout');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Verify proxy URL is correct'));
            assert.ok(formatted.includes('Check network connectivity'));
        });

        test('should include permission suggestions for permission errors', () => {
            aggregator.addError('File operation', 'Access denied');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Check file and directory permissions'));
        });

        test('should include default suggestions when no specific error patterns match', () => {
            aggregator.addError('Unknown operation', 'Something went wrong');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Check the error details above'));
            assert.ok(formatted.includes('Try the operation again'));
        });
    });

    suite('clear()', () => {
        test('should clear all errors', () => {
            aggregator.addError('Git configuration', 'Error 1');
            aggregator.addError('VSCode configuration', 'Error 2');
            assert.strictEqual(aggregator.hasErrors(), true);
            
            aggregator.clear();
            assert.strictEqual(aggregator.hasErrors(), false);
            assert.strictEqual(aggregator.formatErrors(), '');
        });

        test('should allow reuse after clearing', () => {
            aggregator.addError('First error', 'Error message 1');
            aggregator.clear();
            aggregator.addError('Second error', 'Error message 2');
            
            const formatted = aggregator.formatErrors();
            assert.ok(formatted.includes('Second error'));
            assert.ok(!formatted.includes('First error'));
        });
    });

    suite('edge cases', () => {
        test('should handle empty error message', () => {
            aggregator.addError('Operation', '');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Operation:'));
        });

        test('should handle very long error messages', () => {
            const longError = 'A'.repeat(1000);
            aggregator.addError('Operation', longError);
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes(longError));
        });

        test('should handle special characters in operation names', () => {
            aggregator.addError('Git (global) configuration', 'Error');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Git (global) configuration'));
        });

        test('should handle duplicate operation names by overwriting', () => {
            aggregator.addError('Git configuration', 'First error');
            aggregator.addError('Git configuration', 'Second error');
            const formatted = aggregator.formatErrors();
            
            assert.ok(formatted.includes('Second error'));
            assert.ok(!formatted.includes('First error'));
        });
    });
});
