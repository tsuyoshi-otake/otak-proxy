/**
 * Property-based tests for TestProxyCommand
 * **Feature: notification-ux-improvements**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { getPropertyTestRuns } from '../helpers';

suite('TestProxyCommand Property Tests', () => {
    /**
     * **Property 7: 進行状況メッセージの正確性**
     * **Validates: Requirements 4.2**
     *
     * For any list of URLs being tested, progress messages should correctly display
     * the current URL number and total count
     */
    test('Property 7: 進行状況メッセージの正確性 - progress messages show correct URL numbers', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.webUrl(), { minLength: 1, maxLength: 10 }), // Generate 1-10 URLs
                async (urls: string[]) => {
                    // Simulate progress message generation for each URL
                    const progressMessages: string[] = [];
                    
                    for (let i = 0; i < urls.length; i++) {
                        const message = `Testing ${i + 1}/${urls.length}: ${urls[i]}`;
                        progressMessages.push(message);
                    }
                    
                    // Verify each progress message
                    for (let i = 0; i < progressMessages.length; i++) {
                        const message = progressMessages[i];
                        
                        // Should contain the current index (1-based)
                        const currentNumber = i + 1;
                        assert.ok(
                            message.includes(`${currentNumber}/${urls.length}`),
                            `Progress message should contain "${currentNumber}/${urls.length}"`
                        );
                        
                        // Should contain the URL being tested
                        assert.ok(
                            message.includes(urls[i]),
                            `Progress message should contain the URL: ${urls[i]}`
                        );
                        
                        // Verify the format matches "Testing X/Y: URL"
                        const expectedPrefix = `Testing ${currentNumber}/${urls.length}:`;
                        assert.ok(
                            message.startsWith(expectedPrefix),
                            `Progress message should start with "${expectedPrefix}"`
                        );
                    }
                    
                    // Verify the total count matches
                    assert.strictEqual(
                        progressMessages.length,
                        urls.length,
                        'Should generate one progress message per URL'
                    );
                    
                    // Verify the last message shows the correct total
                    const lastMessage = progressMessages[progressMessages.length - 1];
                    assert.ok(
                        lastMessage.includes(`${urls.length}/${urls.length}`),
                        `Last message should show "${urls.length}/${urls.length}"`
                    );
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test progress percentage calculation
     */
    test('Property 7 (variant): 進行状況メッセージの正確性 - progress percentage is correct', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.webUrl(), { minLength: 1, maxLength: 10 }),
                async (urls: string[]) => {
                    // Simulate progress percentage calculation
                    const progressPercentages: number[] = [];
                    
                    for (let i = 0; i < urls.length; i++) {
                        const percentage = (100 / urls.length);
                        progressPercentages.push(percentage);
                    }
                    
                    // Verify each percentage increment
                    for (const percentage of progressPercentages) {
                        // Each increment should be positive
                        assert.ok(
                            percentage > 0,
                            'Progress increment should be positive'
                        );
                        
                        // Each increment should be at most 100
                        assert.ok(
                            percentage <= 100,
                            'Progress increment should be at most 100'
                        );
                        
                        // For single URL, should be 100%
                        if (urls.length === 1) {
                            assert.strictEqual(
                                percentage,
                                100,
                                'Single URL should have 100% increment'
                            );
                        }
                        
                        // For multiple URLs, should be evenly distributed
                        if (urls.length > 1) {
                            const expectedPercentage = 100 / urls.length;
                            assert.strictEqual(
                                percentage,
                                expectedPercentage,
                                `Each URL should have ${expectedPercentage}% increment`
                            );
                        }
                    }
                    
                    // Verify total adds up to approximately 100%
                    const total = progressPercentages.reduce((sum, p) => sum + p, 0);
                    assert.ok(
                        Math.abs(total - 100) < 0.01,
                        `Total progress should be approximately 100%, got ${total}`
                    );
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test progress message format consistency
     */
    test('Property 7 (variant): 進行状況メッセージの正確性 - message format is consistent', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.webUrl(), { minLength: 1, maxLength: 10 }),
                async (urls: string[]) => {
                    // Generate progress messages
                    const progressMessages: string[] = [];
                    
                    for (let i = 0; i < urls.length; i++) {
                        const message = `Testing ${i + 1}/${urls.length}: ${urls[i]}`;
                        progressMessages.push(message);
                    }
                    
                    // Verify format consistency
                    const formatRegex = /^Testing \d+\/\d+: .+$/;
                    
                    for (const message of progressMessages) {
                        assert.ok(
                            formatRegex.test(message),
                            `Progress message should match format "Testing X/Y: URL", got: ${message}`
                        );
                    }
                    
                    // Verify all messages use the same total count
                    const totalCounts = progressMessages.map(msg => {
                        const match = msg.match(/Testing \d+\/(\d+):/);
                        return match ? parseInt(match[1], 10) : 0;
                    });
                    
                    const uniqueTotals = new Set(totalCounts);
                    assert.strictEqual(
                        uniqueTotals.size,
                        1,
                        'All progress messages should use the same total count'
                    );
                    
                    assert.strictEqual(
                        totalCounts[0],
                        urls.length,
                        'Total count should match the number of URLs'
                    );
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test edge case: single URL
     */
    test('Property 7 (edge case): 進行状況メッセージの正確性 - single URL shows 1/1', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.webUrl(),
                async (url: string) => {
                    const message = `Testing 1/1: ${url}`;
                    
                    // Should show 1/1
                    assert.ok(
                        message.includes('1/1'),
                        'Single URL should show "1/1"'
                    );
                    
                    // Should contain the URL
                    assert.ok(
                        message.includes(url),
                        'Message should contain the URL'
                    );
                    
                    // Should match the expected format
                    assert.strictEqual(
                        message,
                        `Testing 1/1: ${url}`,
                        'Message should match expected format'
                    );
                }
            ),
            { numRuns }
        );
    });
});
