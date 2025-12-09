/**
 * @file StateChangeDebouncer.test.ts
 * @description Unit tests for StateChangeDebouncer
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 6.4 - Only notify final state during consecutive changes
 */

import * as assert from 'assert';
import { StateChangeDebouncer, StateChangeEvent, getDefaultDebounceMs } from '../../errors/StateChangeDebouncer';

suite('StateChangeDebouncer Tests', () => {
    let debouncer: StateChangeDebouncer;
    let notifiedEvents: StateChangeEvent[];
    let originalSetTimeout: typeof setTimeout;
    let originalClearTimeout: typeof clearTimeout;
    let timers: Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>;
    let currentTime: number;

    // Mock timers for deterministic testing
    setup(() => {
        notifiedEvents = [];
        timers = new Map();
        currentTime = Date.now();

        // Mock setTimeout
        originalSetTimeout = global.setTimeout;
        originalClearTimeout = global.clearTimeout;

        let timerIdCounter = 1;
        (global as unknown as Record<string, unknown>).setTimeout = ((callback: () => void, delay: number) => {
            const timerId = { id: timerIdCounter++ } as unknown as ReturnType<typeof setTimeout>;
            timers.set(timerId, { callback, delay });
            return timerId;
        }) as typeof setTimeout;

        (global as unknown as Record<string, unknown>).clearTimeout = ((timerId: ReturnType<typeof setTimeout>) => {
            timers.delete(timerId);
        }) as typeof clearTimeout;

        debouncer = new StateChangeDebouncer(1000);
        debouncer.setCallback((event) => {
            notifiedEvents.push(event);
        });
    });

    teardown(() => {
        debouncer.dispose();
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    });

    // Helper to simulate timer expiration
    const advanceTimersBy = (ms: number) => {
        for (const [timerId, timer] of timers.entries()) {
            if (timer.delay <= ms) {
                timer.callback();
                timers.delete(timerId);
            } else {
                timer.delay -= ms;
            }
        }
    };

    suite('queueStateChange', () => {
        test('should queue a state change event', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);

            assert.strictEqual(debouncer.hasPendingChange(event.proxyUrl), true);
            assert.deepStrictEqual(debouncer.getPendingState(event.proxyUrl), event);
        });

        test('should replace pending change with new one for same proxy URL', () => {
            const event1: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };
            const event2: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: false,
                timestamp: currentTime + 500
            };

            debouncer.queueStateChange(event1);
            debouncer.queueStateChange(event2);

            // Should have only the latest event pending
            assert.deepStrictEqual(debouncer.getPendingState(event1.proxyUrl), event2);
        });

        test('should track different proxy URLs independently', () => {
            const event1: StateChangeEvent = {
                proxyUrl: 'http://proxy1.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };
            const event2: StateChangeEvent = {
                proxyUrl: 'http://proxy2.example.com:8080',
                reachable: false,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event1);
            debouncer.queueStateChange(event2);

            assert.strictEqual(debouncer.hasPendingChange(event1.proxyUrl), true);
            assert.strictEqual(debouncer.hasPendingChange(event2.proxyUrl), true);
        });

        test('should notify final state after debounce period', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);

            // Before debounce period
            assert.strictEqual(notifiedEvents.length, 0);

            // After debounce period
            advanceTimersBy(1000);

            assert.strictEqual(notifiedEvents.length, 1);
            assert.deepStrictEqual(notifiedEvents[0], event);
        });

        test('should only notify once for multiple changes within debounce period', () => {
            const event1: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };
            const event2: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: false,
                timestamp: currentTime + 200
            };
            const event3: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime + 400
            };

            // Rapidly fire multiple state changes
            debouncer.queueStateChange(event1);
            debouncer.queueStateChange(event2);
            debouncer.queueStateChange(event3);

            // Wait for debounce
            advanceTimersBy(1000);

            // Should only have notified once with the final state
            assert.strictEqual(notifiedEvents.length, 1);
            assert.deepStrictEqual(notifiedEvents[0], event3);
        });

        test('should clean up after notification', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);
            advanceTimersBy(1000);

            assert.strictEqual(debouncer.hasPendingChange(event.proxyUrl), false);
            assert.strictEqual(debouncer.getPendingState(event.proxyUrl), undefined);
        });
    });

    suite('cancelPendingChange', () => {
        test('should cancel pending change for specific proxy URL', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);
            debouncer.cancelPendingChange(event.proxyUrl);

            assert.strictEqual(debouncer.hasPendingChange(event.proxyUrl), false);
        });

        test('should not notify after cancellation', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);
            debouncer.cancelPendingChange(event.proxyUrl);
            advanceTimersBy(1000);

            assert.strictEqual(notifiedEvents.length, 0);
        });

        test('should not affect other pending changes', () => {
            const event1: StateChangeEvent = {
                proxyUrl: 'http://proxy1.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };
            const event2: StateChangeEvent = {
                proxyUrl: 'http://proxy2.example.com:8080',
                reachable: false,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event1);
            debouncer.queueStateChange(event2);
            debouncer.cancelPendingChange(event1.proxyUrl);

            assert.strictEqual(debouncer.hasPendingChange(event1.proxyUrl), false);
            assert.strictEqual(debouncer.hasPendingChange(event2.proxyUrl), true);

            advanceTimersBy(1000);

            assert.strictEqual(notifiedEvents.length, 1);
            assert.deepStrictEqual(notifiedEvents[0], event2);
        });
    });

    suite('clear', () => {
        test('should clear all pending changes', () => {
            const event1: StateChangeEvent = {
                proxyUrl: 'http://proxy1.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };
            const event2: StateChangeEvent = {
                proxyUrl: 'http://proxy2.example.com:8080',
                reachable: false,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event1);
            debouncer.queueStateChange(event2);
            debouncer.clear();

            assert.strictEqual(debouncer.hasPendingChange(event1.proxyUrl), false);
            assert.strictEqual(debouncer.hasPendingChange(event2.proxyUrl), false);
        });

        test('should not notify after clear', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);
            debouncer.clear();
            advanceTimersBy(1000);

            assert.strictEqual(notifiedEvents.length, 0);
        });
    });

    suite('dispose', () => {
        test('should clear all state and callback', () => {
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            debouncer.queueStateChange(event);
            debouncer.dispose();

            // Should not notify after dispose
            advanceTimersBy(1000);
            assert.strictEqual(notifiedEvents.length, 0);
        });
    });

    suite('custom debounce time', () => {
        test('should use custom debounce time', () => {
            const customDebouncer = new StateChangeDebouncer(500);
            const customEvents: StateChangeEvent[] = [];
            customDebouncer.setCallback((event) => {
                customEvents.push(event);
            });

            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            customDebouncer.queueStateChange(event);

            // At 400ms (before 500ms debounce)
            advanceTimersBy(400);
            assert.strictEqual(customEvents.length, 0);

            // At 500ms (after debounce)
            advanceTimersBy(100);
            assert.strictEqual(customEvents.length, 1);

            customDebouncer.dispose();
        });
    });

    suite('getDefaultDebounceMs', () => {
        test('should return default debounce time of 1000ms', () => {
            assert.strictEqual(getDefaultDebounceMs(), 1000);
        });
    });

    suite('no callback set', () => {
        test('should not throw if callback is not set', () => {
            const noCallbackDebouncer = new StateChangeDebouncer();
            const event: StateChangeEvent = {
                proxyUrl: 'http://proxy.example.com:8080',
                reachable: true,
                timestamp: currentTime
            };

            noCallbackDebouncer.queueStateChange(event);

            // Should not throw
            assert.doesNotThrow(() => {
                advanceTimersBy(1000);
            });

            noCallbackDebouncer.dispose();
        });
    });
});
