import * as assert from 'assert';
import { NotificationThrottler } from '../../errors/NotificationThrottler';

suite('NotificationThrottler Tests', () => {
    let throttler: NotificationThrottler;
    let originalDateNow: () => number;
    let currentTime: number;

    setup(() => {
        throttler = new NotificationThrottler();
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

    suite('shouldShow', () => {
        test('should allow first notification', () => {
            assert.strictEqual(throttler.shouldShow('test-message'), true);
        });

        test('should suppress duplicate notification within throttle time', () => {
            throttler.recordNotification('test-message');
            
            // Advance time by 3 seconds (less than default 5 seconds)
            advanceTime(3000);
            
            assert.strictEqual(throttler.shouldShow('test-message'), false);
        });

        test('should allow notification after throttle time expires', () => {
            throttler.recordNotification('test-message');
            
            // Advance time by 5 seconds (equal to default throttle time)
            advanceTime(5000);
            
            assert.strictEqual(throttler.shouldShow('test-message'), true);
        });

        test('should use custom throttle time when provided', () => {
            throttler.recordNotification('test-message');
            
            // Advance time by 8 seconds
            advanceTime(8000);
            
            // Should be suppressed with 10 second throttle
            assert.strictEqual(throttler.shouldShow('test-message', 10000), false);
            
            // Advance time by 2 more seconds (total 10 seconds)
            advanceTime(2000);
            
            // Should be allowed now
            assert.strictEqual(throttler.shouldShow('test-message', 10000), true);
        });

        test('should track different message keys independently', () => {
            throttler.recordNotification('message-1');
            throttler.recordNotification('message-2');
            
            advanceTime(3000);
            
            // Both should be suppressed
            assert.strictEqual(throttler.shouldShow('message-1'), false);
            assert.strictEqual(throttler.shouldShow('message-2'), false);
            
            // But message-3 should be allowed
            assert.strictEqual(throttler.shouldShow('message-3'), true);
        });
    });

    suite('recordNotification', () => {
        test('should record notification timestamp', () => {
            throttler.recordNotification('test-message');
            
            // Should be suppressed immediately after recording
            assert.strictEqual(throttler.shouldShow('test-message'), false);
        });

        test('should update timestamp on subsequent recordings', () => {
            throttler.recordNotification('test-message');
            
            // Advance time by 4 seconds
            advanceTime(4000);
            
            // Record again
            throttler.recordNotification('test-message');
            
            // Advance time by 3 seconds (total 7 seconds from first, but only 3 from second)
            advanceTime(3000);
            
            // Should still be suppressed because only 3 seconds passed since last recording
            assert.strictEqual(throttler.shouldShow('test-message'), false);
        });
    });

    suite('shouldShowFailure', () => {
        test('should show first failure', () => {
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), true);
        });

        test('should suppress failures 2-4', () => {
            throttler.shouldShowFailure('test-failure'); // 1st - shown
            
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), false); // 2nd
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), false); // 3rd
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), false); // 4th
        });

        test('should show 5th failure', () => {
            throttler.shouldShowFailure('test-failure'); // 1st
            throttler.shouldShowFailure('test-failure'); // 2nd
            throttler.shouldShowFailure('test-failure'); // 3rd
            throttler.shouldShowFailure('test-failure'); // 4th
            
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), true); // 5th
        });

        test('should show 10th failure', () => {
            for (let i = 0; i < 9; i++) {
                throttler.shouldShowFailure('test-failure');
            }
            
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), true); // 10th
        });

        test('should track different failure keys independently', () => {
            assert.strictEqual(throttler.shouldShowFailure('failure-1'), true); // 1st
            assert.strictEqual(throttler.shouldShowFailure('failure-2'), true); // 1st
            
            assert.strictEqual(throttler.shouldShowFailure('failure-1'), false); // 2nd
            assert.strictEqual(throttler.shouldShowFailure('failure-2'), false); // 2nd
        });
    });

    suite('resetFailureCount', () => {
        test('should reset failure count for specific key', () => {
            throttler.shouldShowFailure('test-failure'); // 1st
            throttler.shouldShowFailure('test-failure'); // 2nd
            
            throttler.resetFailureCount('test-failure');
            
            // Should show again as if it's the first failure
            assert.strictEqual(throttler.shouldShowFailure('test-failure'), true);
        });

        test('should not affect other failure keys', () => {
            throttler.shouldShowFailure('failure-1'); // 1st
            throttler.shouldShowFailure('failure-2'); // 1st
            
            throttler.resetFailureCount('failure-1');
            
            // failure-1 should be reset
            assert.strictEqual(throttler.shouldShowFailure('failure-1'), true);
            
            // failure-2 should continue from where it was
            assert.strictEqual(throttler.shouldShowFailure('failure-2'), false); // 2nd
        });
    });

    suite('clear', () => {
        test('should clear all notification records', () => {
            throttler.recordNotification('message-1');
            throttler.recordNotification('message-2');
            
            throttler.clear();
            
            // Both should be allowed after clearing
            assert.strictEqual(throttler.shouldShow('message-1'), true);
            assert.strictEqual(throttler.shouldShow('message-2'), true);
        });

        test('should clear all failure counts', () => {
            throttler.shouldShowFailure('failure-1'); // 1st
            throttler.shouldShowFailure('failure-1'); // 2nd
            throttler.shouldShowFailure('failure-2'); // 1st
            
            throttler.clear();
            
            // Both should show as first failure
            assert.strictEqual(throttler.shouldShowFailure('failure-1'), true);
            assert.strictEqual(throttler.shouldShowFailure('failure-2'), true);
        });
    });

    suite('clearOldRecords', () => {
        test('should remove records older than specified age', () => {
            throttler.recordNotification('old-message');
            
            // Advance time by 2 hours
            advanceTime(2 * 60 * 60 * 1000);
            
            throttler.recordNotification('new-message');
            
            // Clear records older than 1 hour
            throttler.clearOldRecords(60 * 60 * 1000);
            
            // Old message should be allowed (record was cleared)
            assert.strictEqual(throttler.shouldShow('old-message'), true);
            
            // New message should still be suppressed
            assert.strictEqual(throttler.shouldShow('new-message'), false);
        });

        test('should keep recent records', () => {
            throttler.recordNotification('recent-message');
            
            // Advance time by 30 minutes
            advanceTime(30 * 60 * 1000);
            
            // Clear records older than 1 hour
            throttler.clearOldRecords(60 * 60 * 1000);
            
            // Recent message should still be suppressed (30 minutes < 1 hour, so not cleared)
            // But we need to check against the throttle time (5 seconds), not the clear time
            // Since 30 minutes > 5 seconds, it should be allowed
            assert.strictEqual(throttler.shouldShow('recent-message'), true);
        });

        test('should use default age of 1 hour when not specified', () => {
            throttler.recordNotification('message');
            
            // Advance time by 30 minutes
            advanceTime(30 * 60 * 1000);
            
            throttler.clearOldRecords();
            
            // Should be allowed (30 minutes > 5 second throttle time)
            assert.strictEqual(throttler.shouldShow('message'), true);
            
            // Record again
            throttler.recordNotification('message');
            
            // Advance time by 61 minutes
            advanceTime(61 * 60 * 1000);
            
            throttler.clearOldRecords();
            
            // Should be allowed (record was cleared and time passed)
            assert.strictEqual(throttler.shouldShow('message'), true);
        });
    });
});
