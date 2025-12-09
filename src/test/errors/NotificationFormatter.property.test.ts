/**
 * Property-based tests for NotificationFormatter
 * **Feature: notification-ux-improvements**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { NotificationFormatter } from '../../errors/NotificationFormatter';
import { getPropertyTestRuns } from '../helpers';

suite('NotificationFormatter Property Tests', () => {
    /**
     * **Property 1: メッセージ長制限**
     * **Validates: Requirements 1.4**
     *
     * For any message, the summarized message should be at most 200 characters
     */
    test('Property 1: メッセージ長制限 - summarized messages are within 200 characters', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 1000 }), // Generate messages of various lengths
                async (message: string) => {
                    const result = NotificationFormatter.summarize(message);
                    
                    // Verify the result is at most 200 characters
                    assert.ok(
                        result.length <= 200,
                        `Summarized message length ${result.length} should be <= 200`
                    );
                    
                    // If original was under limit, should be unchanged
                    if (message.length <= 200) {
                        assert.strictEqual(
                            result,
                            message,
                            'Messages under 200 chars should not be modified'
                        );
                    }
                    
                    // If original was over limit, should end with ellipsis
                    if (message.length > 200) {
                        assert.ok(
                            result.endsWith('...'),
                            'Truncated messages should end with ellipsis'
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test with custom max length parameter
     */
    test('Property 1 (variant): メッセージ長制限 - custom max length is respected', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 500 }),
                fc.integer({ min: 10, max: 300 }), // Custom max length
                async (message: string, maxLength: number) => {
                    const result = NotificationFormatter.summarize(message, maxLength);
                    
                    // Verify the result is at most maxLength characters
                    assert.ok(
                        result.length <= maxLength,
                        `Summarized message length ${result.length} should be <= ${maxLength}`
                    );
                    
                    // If original was under limit, should be unchanged
                    if (message.length <= maxLength) {
                        assert.strictEqual(
                            result,
                            message,
                            `Messages under ${maxLength} chars should not be modified`
                        );
                    }
                    
                    // If original was over limit, should end with ellipsis
                    if (message.length > maxLength) {
                        assert.ok(
                            result.endsWith('...'),
                            'Truncated messages should end with ellipsis'
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * **Property 2: 提案の要約**
     * **Validates: Requirements 1.2**
     *
     * For any list of suggestions, the summarized list should contain at most 3 suggestions
     */
    test('Property 2: 提案の要約 - summarized suggestions are at most 3', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 5, maxLength: 100 }), { minLength: 0, maxLength: 20 }),
                async (suggestions: string[]) => {
                    const result = NotificationFormatter.summarizeSuggestions(suggestions);
                    
                    // Verify the result has at most 3 suggestions
                    assert.ok(
                        result.length <= 3,
                        `Summarized suggestions count ${result.length} should be <= 3`
                    );
                    
                    // If original had 3 or fewer, should be unchanged
                    if (suggestions.length <= 3) {
                        assert.deepStrictEqual(
                            result,
                            suggestions,
                            'Suggestions with 3 or fewer items should not be modified'
                        );
                    }
                    
                    // If original had more than 3, should return first 3
                    if (suggestions.length > 3) {
                        assert.deepStrictEqual(
                            result,
                            suggestions.slice(0, 3),
                            'Should return first 3 suggestions when more than 3 provided'
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test with custom max count parameter
     */
    test('Property 2 (variant): 提案の要約 - custom max count is respected', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 5, maxLength: 100 }), { minLength: 0, maxLength: 20 }),
                fc.integer({ min: 1, max: 10 }), // Custom max count
                async (suggestions: string[], maxCount: number) => {
                    const result = NotificationFormatter.summarizeSuggestions(suggestions, maxCount);
                    
                    // Verify the result has at most maxCount suggestions
                    assert.ok(
                        result.length <= maxCount,
                        `Summarized suggestions count ${result.length} should be <= ${maxCount}`
                    );
                    
                    // If original had maxCount or fewer, should be unchanged
                    if (suggestions.length <= maxCount) {
                        assert.deepStrictEqual(
                            result,
                            suggestions,
                            `Suggestions with ${maxCount} or fewer items should not be modified`
                        );
                    }
                    
                    // If original had more than maxCount, should return first maxCount
                    if (suggestions.length > maxCount) {
                        assert.deepStrictEqual(
                            result,
                            suggestions.slice(0, maxCount),
                            `Should return first ${maxCount} suggestions when more than ${maxCount} provided`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * **Property 3: URLリストの要約**
     * **Validates: Requirements 1.3**
     *
     * For any list of URLs, the summarized string should display at most 2 URLs
     */
    test('Property 3: URLリストの要約 - summarized URLs display at most 2', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.webUrl(), { minLength: 0, maxLength: 20 }),
                async (urls: string[]) => {
                    const result = NotificationFormatter.summarizeUrls(urls);
                    
                    // Empty array should return empty string
                    if (urls.length === 0) {
                        assert.strictEqual(result, '', 'Empty URL array should return empty string');
                        return;
                    }
                    
                    // Count how many URLs are displayed in the result
                    // URLs are comma-separated, so count commas + 1 (but exclude "+X more" part)
                    const displayedPart = result.split(' (+')[0];
                    const displayedUrls = displayedPart.split(', ').filter(s => s.length > 0);
                    
                    // Should display at most 2 URLs
                    assert.ok(
                        displayedUrls.length <= 2,
                        `Should display at most 2 URLs, but displayed ${displayedUrls.length}`
                    );
                    
                    // If 2 or fewer URLs, should display all without "+X more"
                    if (urls.length <= 2) {
                        assert.ok(
                            !result.includes('+'),
                            'Should not include "+X more" when 2 or fewer URLs'
                        );
                        assert.strictEqual(
                            displayedUrls.length,
                            urls.length,
                            'Should display all URLs when 2 or fewer'
                        );
                    }
                    
                    // If more than 2 URLs, should show "+X more"
                    if (urls.length > 2) {
                        assert.ok(
                            result.includes('+'),
                            'Should include "+X more" when more than 2 URLs'
                        );
                        assert.strictEqual(
                            displayedUrls.length,
                            2,
                            'Should display exactly 2 URLs when more than 2 provided'
                        );
                        
                        // Verify the count is correct
                        const remaining = urls.length - 2;
                        assert.ok(
                            result.includes(`+${remaining} more`),
                            `Should show "+${remaining} more"`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test with custom max count parameter
     */
    test('Property 3 (variant): URLリストの要約 - custom max count is respected', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.webUrl(), { minLength: 0, maxLength: 20 }),
                fc.integer({ min: 1, max: 5 }), // Custom max count
                async (urls: string[], maxCount: number) => {
                    const result = NotificationFormatter.summarizeUrls(urls, maxCount);
                    
                    // Empty array should return empty string
                    if (urls.length === 0) {
                        assert.strictEqual(result, '', 'Empty URL array should return empty string');
                        return;
                    }
                    
                    // Count how many URLs are displayed in the result
                    const displayedPart = result.split(' (+')[0];
                    const displayedUrls = displayedPart.split(', ').filter(s => s.length > 0);
                    
                    // Should display at most maxCount URLs
                    assert.ok(
                        displayedUrls.length <= maxCount,
                        `Should display at most ${maxCount} URLs, but displayed ${displayedUrls.length}`
                    );
                    
                    // If maxCount or fewer URLs, should display all without "+X more"
                    if (urls.length <= maxCount) {
                        assert.ok(
                            !result.includes('+'),
                            `Should not include "+X more" when ${maxCount} or fewer URLs`
                        );
                        assert.strictEqual(
                            displayedUrls.length,
                            urls.length,
                            `Should display all URLs when ${maxCount} or fewer`
                        );
                    }
                    
                    // If more than maxCount URLs, should show "+X more"
                    if (urls.length > maxCount) {
                        assert.ok(
                            result.includes('+'),
                            `Should include "+X more" when more than ${maxCount} URLs`
                        );
                        assert.strictEqual(
                            displayedUrls.length,
                            maxCount,
                            `Should display exactly ${maxCount} URLs when more than ${maxCount} provided`
                        );
                        
                        // Verify the count is correct
                        const remaining = urls.length - maxCount;
                        assert.ok(
                            result.includes(`+${remaining} more`),
                            `Should show "+${remaining} more"`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });
});
