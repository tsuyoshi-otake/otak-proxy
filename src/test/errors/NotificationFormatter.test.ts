import * as assert from 'assert';
import { NotificationFormatter } from '../../errors/NotificationFormatter';

suite('NotificationFormatter Tests', () => {
    suite('summarize', () => {
        test('should return message as-is when under limit', () => {
            const message = 'Short message';
            const result = NotificationFormatter.summarize(message);
            assert.strictEqual(result, message);
        });

        test('should truncate message when over default limit (200 chars)', () => {
            const message = 'a'.repeat(250);
            const result = NotificationFormatter.summarize(message);
            assert.strictEqual(result.length, 200);
            assert.ok(result.endsWith('...'));
        });

        test('should truncate message when over custom limit', () => {
            const message = 'a'.repeat(150);
            const result = NotificationFormatter.summarize(message, 100);
            assert.strictEqual(result.length, 100);
            assert.ok(result.endsWith('...'));
        });

        test('should handle empty message', () => {
            const result = NotificationFormatter.summarize('');
            assert.strictEqual(result, '');
        });

        test('should handle message exactly at limit', () => {
            const message = 'a'.repeat(200);
            const result = NotificationFormatter.summarize(message);
            assert.strictEqual(result, message);
        });
    });

    suite('summarizeSuggestions', () => {
        test('should return all suggestions when under limit', () => {
            const suggestions = ['Suggestion 1', 'Suggestion 2'];
            const result = NotificationFormatter.summarizeSuggestions(suggestions);
            assert.deepStrictEqual(result, suggestions);
        });

        test('should limit suggestions to default max (3)', () => {
            const suggestions = ['Suggestion 1', 'Suggestion 2', 'Suggestion 3', 'Suggestion 4', 'Suggestion 5'];
            const result = NotificationFormatter.summarizeSuggestions(suggestions);
            assert.strictEqual(result.length, 3);
            assert.deepStrictEqual(result, ['Suggestion 1', 'Suggestion 2', 'Suggestion 3']);
        });

        test('should limit suggestions to custom max', () => {
            const suggestions = ['Suggestion 1', 'Suggestion 2', 'Suggestion 3', 'Suggestion 4'];
            const result = NotificationFormatter.summarizeSuggestions(suggestions, 2);
            assert.strictEqual(result.length, 2);
            assert.deepStrictEqual(result, ['Suggestion 1', 'Suggestion 2']);
        });

        test('should handle empty suggestions array', () => {
            const result = NotificationFormatter.summarizeSuggestions([]);
            assert.deepStrictEqual(result, []);
        });

        test('should handle exactly 3 suggestions', () => {
            const suggestions = ['Suggestion 1', 'Suggestion 2', 'Suggestion 3'];
            const result = NotificationFormatter.summarizeSuggestions(suggestions);
            assert.deepStrictEqual(result, suggestions);
        });
    });

    suite('summarizeUrls', () => {
        test('should return empty string for empty array', () => {
            const result = NotificationFormatter.summarizeUrls([]);
            assert.strictEqual(result, '');
        });

        test('should return single URL as-is', () => {
            const urls = ['http://proxy1.example.com:8080'];
            const result = NotificationFormatter.summarizeUrls(urls);
            assert.strictEqual(result, 'http://proxy1.example.com:8080');
        });

        test('should return two URLs joined by comma', () => {
            const urls = ['http://proxy1.example.com:8080', 'http://proxy2.example.com:8080'];
            const result = NotificationFormatter.summarizeUrls(urls);
            assert.strictEqual(result, 'http://proxy1.example.com:8080, http://proxy2.example.com:8080');
        });

        test('should limit URLs to default max (2) and show count', () => {
            const urls = [
                'http://proxy1.example.com:8080',
                'http://proxy2.example.com:8080',
                'http://proxy3.example.com:8080',
                'http://proxy4.example.com:8080'
            ];
            const result = NotificationFormatter.summarizeUrls(urls);
            assert.strictEqual(result, 'http://proxy1.example.com:8080, http://proxy2.example.com:8080 (+2 more)');
        });

        test('should limit URLs to custom max and show count', () => {
            const urls = [
                'http://proxy1.example.com:8080',
                'http://proxy2.example.com:8080',
                'http://proxy3.example.com:8080'
            ];
            const result = NotificationFormatter.summarizeUrls(urls, 1);
            assert.strictEqual(result, 'http://proxy1.example.com:8080 (+2 more)');
        });
    });

    suite('formatError', () => {
        test('should return summarized message without suggestion', () => {
            const message = 'Error occurred';
            const result = NotificationFormatter.formatError(message);
            assert.strictEqual(result, message);
        });

        test('should format message with primary suggestion', () => {
            const message = 'Error occurred';
            const suggestion = 'Try this fix';
            const result = NotificationFormatter.formatError(message, suggestion);
            assert.ok(result.includes('Error occurred'));
            assert.ok(result.includes('💡 Try this fix'));
        });

        test('should truncate long message', () => {
            const message = 'a'.repeat(250);
            const result = NotificationFormatter.formatError(message);
            assert.strictEqual(result.length, 200);
            assert.ok(result.endsWith('...'));
        });

        test('should truncate long suggestion', () => {
            const message = 'Error occurred';
            const suggestion = 'b'.repeat(150);
            const result = NotificationFormatter.formatError(message, suggestion);
            assert.ok(result.includes('Error occurred'));
            assert.ok(result.includes('💡'));
            // Suggestion should be truncated to 100 chars
            const suggestionPart = result.split('💡 ')[1];
            assert.strictEqual(suggestionPart.length, 100);
            assert.ok(suggestionPart.endsWith('...'));
        });

        test('should handle empty message', () => {
            const result = NotificationFormatter.formatError('');
            assert.strictEqual(result, '');
        });
    });
});
