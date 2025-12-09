/**
 * Property-based tests for ProxyTestScheduler
 * Feature: auto-mode-proxy-testing
 *
 * These tests verify the correctness properties defined in the design document
 * using fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { getPropertyTestRuns } from '../helpers';
import { ProxyTestScheduler, getMinInterval, getMaxInterval } from '../../monitoring/ProxyTestScheduler';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../../errors/UserNotifier';

suite('ProxyTestScheduler Property Tests', function() {
    const numRuns = getPropertyTestRuns();
    this.timeout(30000);

    let sandbox: sinon.SinonSandbox;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let tester: ProxyConnectionTester;
    let scheduler: ProxyTestScheduler;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockNotifier = sandbox.createStubInstance(UserNotifier);
        tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
    });

    teardown(() => {
        if (scheduler) {
            scheduler.stop();
        }
        sandbox.restore();
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 9: テスト間隔設定の範囲検証
     * Validates: Requirements 8.3
     *
     * For any test interval value, it should be clamped to 30s-600s range.
     */
    suite('Property 9: Test interval range validation', () => {
        test('interval should be clamped to valid range for any input', () => {
            fc.assert(
                fc.property(
                    // Generate any integer, including negative and very large
                    fc.integer({ min: -100000, max: 1000000 }),
                    (intervalMs) => {
                        scheduler = new ProxyTestScheduler(tester, intervalMs);
                        const actualInterval = scheduler.getIntervalMs();

                        // Should be within valid range
                        assert.ok(actualInterval >= getMinInterval(),
                            `Interval ${actualInterval} should be >= ${getMinInterval()}`);
                        assert.ok(actualInterval <= getMaxInterval(),
                            `Interval ${actualInterval} should be <= ${getMaxInterval()}`);
                    }
                ),
                { numRuns }
            );
        });

        test('updateInterval should clamp to valid range', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: -100000, max: 1000000 }),
                    (intervalMs) => {
                        scheduler = new ProxyTestScheduler(tester, 60000);
                        scheduler.updateInterval(intervalMs);
                        const actualInterval = scheduler.getIntervalMs();

                        // Should be within valid range
                        assert.ok(actualInterval >= getMinInterval(),
                            `Updated interval ${actualInterval} should be >= ${getMinInterval()}`);
                        assert.ok(actualInterval <= getMaxInterval(),
                            `Updated interval ${actualInterval} should be <= ${getMaxInterval()}`);
                    }
                ),
                { numRuns }
            );
        });

        test('valid intervals should be preserved exactly', () => {
            fc.assert(
                fc.property(
                    // Generate valid intervals
                    fc.integer({ min: getMinInterval(), max: getMaxInterval() }),
                    (intervalMs) => {
                        scheduler = new ProxyTestScheduler(tester, intervalMs);
                        const actualInterval = scheduler.getIntervalMs();

                        // Valid intervals should be preserved exactly
                        assert.strictEqual(actualInterval, intervalMs,
                            `Valid interval ${intervalMs} should be preserved`);
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 10: 設定変更時のタイマー更新
     * Validates: Requirements 8.2
     *
     * When interval is updated, the new interval should take effect.
     */
    suite('Property 10: Timer update on config change', () => {
        test('updateInterval should update the stored interval', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: getMinInterval(), max: getMaxInterval() }),
                    fc.integer({ min: getMinInterval(), max: getMaxInterval() }),
                    (initialInterval, newInterval) => {
                        scheduler = new ProxyTestScheduler(tester, initialInterval);
                        scheduler.updateInterval(newInterval);

                        assert.strictEqual(scheduler.getIntervalMs(), newInterval,
                            'Interval should be updated');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 5: 定期テストによる状態更新
     * Validates: Requirements 3.2, 3.3
     *
     * Scheduler should maintain active state correctly.
     */
    suite('Property 5: Periodic test state updates', () => {
        test('start/stop should toggle active state correctly', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10 }),
                    (cycles) => {
                        scheduler = new ProxyTestScheduler(tester, 60000);

                        for (let i = 0; i < cycles; i++) {
                            // Start
                            scheduler.start('http://proxy:8080', () => {});
                            assert.strictEqual(scheduler.isActive(), true,
                                `Should be active after start (cycle ${i})`);

                            // Stop
                            scheduler.stop();
                            assert.strictEqual(scheduler.isActive(), false,
                                `Should be inactive after stop (cycle ${i})`);
                        }
                    }
                ),
                { numRuns }
            );
        });

        test('getCurrentProxyUrl should track proxy URL correctly', () => {
            fc.assert(
                fc.property(
                    fc.array(
                        fc.integer({ min: 1, max: 65535 }).map(port => `http://proxy-${port}:${port}`),
                        { minLength: 1, maxLength: 5 }
                    ),
                    (proxyUrls) => {
                        scheduler = new ProxyTestScheduler(tester, 60000);
                        const callback = () => {};

                        for (const proxyUrl of proxyUrls) {
                            if (!scheduler.isActive()) {
                                scheduler.start(proxyUrl, callback);
                            } else {
                                scheduler.updateProxyUrl(proxyUrl);
                            }

                            assert.strictEqual(scheduler.getCurrentProxyUrl(), proxyUrl,
                                `Proxy URL should be ${proxyUrl}`);
                        }

                        scheduler.stop();
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Idempotency tests
     */
    suite('Idempotency', () => {
        test('multiple stop calls should be safe', () => {
            fc.assert(
                fc.property(
                    fc.integer({ min: 1, max: 10 }),
                    (stopCount) => {
                        scheduler = new ProxyTestScheduler(tester, 60000);
                        scheduler.start('http://proxy:8080', () => {});

                        // Multiple stops should not throw
                        for (let i = 0; i < stopCount; i++) {
                            scheduler.stop();
                            assert.strictEqual(scheduler.isActive(), false,
                                `Should be inactive after stop ${i}`);
                        }
                    }
                ),
                { numRuns }
            );
        });
    });
});
