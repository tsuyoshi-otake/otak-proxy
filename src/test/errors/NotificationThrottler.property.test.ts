/**
 * Property-based tests for NotificationThrottler
 * **Feature: notification-ux-improvements**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { NotificationThrottler } from '../../errors/NotificationThrottler';
import { getPropertyTestRuns } from '../helpers';

suite('NotificationThrottler Property Tests', () => {
    let originalDateNow: () => number;
    let currentTime: number;

    setup(() => {
        currentTime = Date.now();
        originalDateNow = Date.now;
        Date.now = () => currentTime;
    });

    teardown(() => {
        Date.now = originalDateNow;
    });

    const advanceTime = (ms: number) => {
        currentTime += ms;
    };

    /**
     * **Property 5: 通知の重複抑制**
     * **Validates: Requirements 7.1, 7.2, 7.3**
     *
     * For any notification message, the same message should not be shown multiple times
     * within the specified throttle time
     */
    test('Property 5: 通知の重複抑制 - same message is suppressed within throttle time', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 100 }), // Message key
                fc.integer({ min: 1000, max: 30000 }), // Throttle time in ms
                fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 10 }), // Time intervals
                async (messageKey: string, throttleMs: number, timeIntervals: number[]) => {
                    const throttler = new NotificationThrottler();
                    
                    // First notification should always be shown
                    assert.strictEqual(
                        throttler.shouldShow(messageKey, throttleMs),
                        true,
                        'First notification should always be shown'
                    );
                    
                    throttler.recordNotification(messageKey);
                    
                    // Test subsequent notifications at various time intervals
                    let totalElapsed = 0;
                    for (const interval of timeIntervals) {
                        advanceTime(interval);
                        totalElapsed += interval;
                        
                        const shouldShow = throttler.shouldShow(messageKey, throttleMs);
                        
                        if (totalElapsed < throttleMs) {
                            // Should be suppressed if within throttle time
                            assert.strictEqual(
                                shouldShow,
                                false,
                                `Notification should be suppressed at ${totalElapsed}ms (throttle: ${throttleMs}ms)`
                            );
                        } else {
                            // Should be allowed if throttle time has passed
                            assert.strictEqual(
                                shouldShow,
                                true,
                                `Notification should be allowed at ${totalElapsed}ms (throttle: ${throttleMs}ms)`
                            );
                            
                            // Record and reset for next iteration
                            throttler.recordNotification(messageKey);
                            totalElapsed = 0;
                        }
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test that different message keys are tracked independently
     */
    test('Property 5 (variant): 通知の重複抑制 - different messages are tracked independently', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 10 }), // Multiple message keys
                fc.integer({ min: 1000, max: 10000 }), // Throttle time
                fc.integer({ min: 0, max: 5000 }), // Time to advance
                async (messageKeys: string[], throttleMs: number, timeAdvance: number) => {
                    // Ensure unique keys
                    const uniqueKeys = Array.from(new Set(messageKeys));
                    if (uniqueKeys.length < 2) {
                        return; // Skip if not enough unique keys
                    }
                    
                    const throttler = new NotificationThrottler();
                    
                    // Record all messages
                    for (const key of uniqueKeys) {
                        throttler.shouldShow(key, throttleMs);
                        throttler.recordNotification(key);
                    }
                    
                    // Advance time
                    advanceTime(timeAdvance);
                    
                    // All messages should have the same suppression status
                    const firstResult = throttler.shouldShow(uniqueKeys[0], throttleMs);
                    const expectedResult = timeAdvance >= throttleMs;
                    
                    assert.strictEqual(
                        firstResult,
                        expectedResult,
                        `First message should ${expectedResult ? 'be allowed' : 'be suppressed'}`
                    );
                    
                    // All other messages should have the same status
                    for (let i = 1; i < uniqueKeys.length; i++) {
                        const result = throttler.shouldShow(uniqueKeys[i], throttleMs);
                        assert.strictEqual(
                            result,
                            firstResult,
                            `Message ${i} should have same status as first message`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test that clearOldRecords properly removes old entries
     */
    test('Property 5 (variant): 通知の重複抑制 - old records are cleared correctly', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
                fc.integer({ min: 60000, max: 7200000 }), // Max age (1 minute to 2 hours)
                fc.array(fc.integer({ min: 0, max: 3600000 }), { minLength: 1, maxLength: 5 }), // Time intervals
                async (messageKeys: string[], maxAge: number, timeIntervals: number[]) => {
                    const throttler = new NotificationThrottler();
                    const uniqueKeys = Array.from(new Set(messageKeys));
                    
                    if (uniqueKeys.length === 0) {
                        return;
                    }
                    
                    // Record messages at different times
                    const recordTimes: number[] = [];
                    for (const key of uniqueKeys) {
                        throttler.recordNotification(key);
                        recordTimes.push(currentTime);
                        
                        if (timeIntervals.length > 0) {
                            advanceTime(timeIntervals[0]);
                        }
                    }
                    
                    // Advance time significantly
                    advanceTime(maxAge + 1000);
                    
                    // Clear old records
                    throttler.clearOldRecords(maxAge);
                    
                    // All messages should be allowed now (records were cleared)
                    for (const key of uniqueKeys) {
                        assert.strictEqual(
                            throttler.shouldShow(key),
                            true,
                            `Message "${key}" should be allowed after clearing old records`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * **Property 6: 連続失敗の通知制御**
     * **Validates: Requirements 7.4**
     *
     * For any sequence of consecutive failures, notifications should only be shown
     * on the 1st failure and every 5th failure (5th, 10th, 15th, etc.)
     */
    test('Property 6: 連続失敗の通知制御 - notifications shown on 1st and every 5th failure', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 100 }), // Failure key
                fc.integer({ min: 1, max: 20 }), // Number of consecutive failures
                async (failureKey: string, numFailures: number) => {
                    const throttler = new NotificationThrottler();
                    
                    for (let i = 1; i <= numFailures; i++) {
                        const shouldShow = throttler.shouldShowFailure(failureKey);
                        
                        // Should show on 1st failure and every 5th failure
                        const expectedShow = i === 1 || i % 5 === 0;
                        
                        assert.strictEqual(
                            shouldShow,
                            expectedShow,
                            `Failure ${i}: should ${expectedShow ? 'show' : 'suppress'} notification`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test that different failure keys are tracked independently
     */
    test('Property 6 (variant): 連続失敗の通知制御 - different failure keys tracked independently', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 5 }), // Multiple failure keys
                fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 2, maxLength: 5 }), // Failure counts per key
                async (failureKeys: string[], failureCounts: number[]) => {
                    const uniqueKeys = Array.from(new Set(failureKeys));
                    if (uniqueKeys.length < 2) {
                        return; // Skip if not enough unique keys
                    }
                    
                    const throttler = new NotificationThrottler();
                    
                    // Track expected counts for each key
                    const counts = new Map<string, number>();
                    
                    // Interleave failures from different keys
                    const maxIterations = Math.max(...failureCounts.slice(0, uniqueKeys.length));
                    for (let i = 0; i < maxIterations; i++) {
                        for (let j = 0; j < uniqueKeys.length; j++) {
                            const key = uniqueKeys[j];
                            const maxCount = failureCounts[j] || 1;
                            
                            if (i < maxCount) {
                                const currentCount = (counts.get(key) || 0) + 1;
                                counts.set(key, currentCount);
                                
                                const shouldShow = throttler.shouldShowFailure(key);
                                const expectedShow = currentCount === 1 || currentCount % 5 === 0;
                                
                                assert.strictEqual(
                                    shouldShow,
                                    expectedShow,
                                    `Key "${key}" failure ${currentCount}: should ${expectedShow ? 'show' : 'suppress'}`
                                );
                            }
                        }
                    }
                }
            ),
            { numRuns }
        );
    });

    /**
     * Test that resetFailureCount properly resets the counter
     */
    test('Property 6 (variant): 連続失敗の通知制御 - reset properly restarts count', async () => {
        const numRuns = getPropertyTestRuns();

        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 100 }), // Failure key
                fc.integer({ min: 2, max: 10 }), // Failures before reset
                fc.integer({ min: 1, max: 10 }), // Failures after reset
                async (failureKey: string, failuresBeforeReset: number, failuresAfterReset: number) => {
                    const throttler = new NotificationThrottler();
                    
                    // Generate failures before reset
                    for (let i = 1; i <= failuresBeforeReset; i++) {
                        throttler.shouldShowFailure(failureKey);
                    }
                    
                    // Reset the counter
                    throttler.resetFailureCount(failureKey);
                    
                    // Generate failures after reset - should behave as if starting fresh
                    for (let i = 1; i <= failuresAfterReset; i++) {
                        const shouldShow = throttler.shouldShowFailure(failureKey);
                        const expectedShow = i === 1 || i % 5 === 0;
                        
                        assert.strictEqual(
                            shouldShow,
                            expectedShow,
                            `After reset, failure ${i}: should ${expectedShow ? 'show' : 'suppress'}`
                        );
                    }
                }
            ),
            { numRuns }
        );
    });
});
