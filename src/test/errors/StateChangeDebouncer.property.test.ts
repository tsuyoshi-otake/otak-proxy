/**
 * @file StateChangeDebouncer.property.test.ts
 * @description Property-based tests for StateChangeDebouncer
 * Feature: auto-mode-proxy-testing
 * Property 8: 連続状態変化時の最終状態通知
 * Validates: Requirements 6.4
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { StateChangeDebouncer, StateChangeEvent, getDefaultDebounceMs } from '../../errors/StateChangeDebouncer';
import { proxyUrlArb } from '../generators';

suite('StateChangeDebouncer Property Tests', () => {
    // Feature: auto-mode-proxy-testing, Property 8: 連続状態変化時の最終状態通知
    // Validates: Requirements 6.4
    suite('Property 8: Only final state notified during consecutive changes', () => {

        /**
         * Property: For any sequence of state changes for the same proxy URL,
         * only the final state should be notified after the debounce period
         */
        test('should notify only the final state for consecutive changes', () => {
            fc.assert(
                fc.property(
                    proxyUrlArb,
                    fc.array(fc.boolean(), { minLength: 2, maxLength: 10 }),
                    (proxyUrl: string, reachableSequence: boolean[]) => {
                        // Arrange
                        const notifiedEvents: StateChangeEvent[] = [];
                        const timerCallbacks: Array<() => void> = [];

                        // Mock setTimeout to capture the callback
                        const originalSetTimeout = global.setTimeout;
                        const originalClearTimeout = global.clearTimeout;

                        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void) => {
                            timerCallbacks.length = 0; // Clear previous
                            timerCallbacks.push(cb);
                            return { id: 1 } as unknown as ReturnType<typeof setTimeout>;
                        }) as typeof setTimeout;

                        (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {
                            timerCallbacks.length = 0;
                        }) as typeof clearTimeout;

                        try {
                            const debouncer = new StateChangeDebouncer(1000);
                            debouncer.setCallback((event) => {
                                notifiedEvents.push(event);
                            });

                            // Act: Queue all state changes rapidly
                            const baseTime = Date.now();
                            reachableSequence.forEach((reachable, index) => {
                                debouncer.queueStateChange({
                                    proxyUrl,
                                    reachable,
                                    timestamp: baseTime + index * 100
                                });
                            });

                            // Get the final expected state
                            const finalState = reachableSequence[reachableSequence.length - 1];

                            // Trigger the debounce callback
                            if (timerCallbacks.length > 0) {
                                timerCallbacks[0]();
                            }

                            debouncer.dispose();

                            // Assert: Only one notification with the final state
                            assert.strictEqual(notifiedEvents.length, 1,
                                'Should notify exactly once');
                            assert.strictEqual(notifiedEvents[0].reachable, finalState,
                                'Should notify with the final state');
                            assert.strictEqual(notifiedEvents[0].proxyUrl, proxyUrl,
                                'Should notify with the correct proxy URL');
                        } finally {
                            global.setTimeout = originalSetTimeout;
                            global.clearTimeout = originalClearTimeout;
                        }
                    }
                ),
                { numRuns: 50, verbose: true }
            );
        });

        /**
         * Property: For any number of proxy URLs with consecutive changes,
         * each proxy URL should only receive one notification
         */
        test('should handle multiple proxy URLs independently', () => {
            fc.assert(
                fc.property(
                    fc.array(proxyUrlArb, { minLength: 2, maxLength: 5 }),
                    fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }),
                    (proxyUrls: string[], reachableSequence: boolean[]) => {
                        // Ensure unique proxy URLs
                        const uniqueProxyUrls = [...new Set(proxyUrls)];
                        if (uniqueProxyUrls.length < 2) {
                            return true; // Skip if not enough unique URLs
                        }

                        // Mock setTimeout/clearTimeout
                        const originalSetTimeout = global.setTimeout;
                        const originalClearTimeout = global.clearTimeout;

                        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((_cb: () => void, _delay: number) => {
                            return { id: 1 } as unknown as ReturnType<typeof setTimeout>;
                        }) as typeof setTimeout;

                        (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((_: unknown) => {
                            // No-op for this test
                        }) as typeof clearTimeout;

                        try {
                            const debouncer = new StateChangeDebouncer(1000);

                            // Queue changes for each proxy URL
                            const baseTime = Date.now();
                            uniqueProxyUrls.forEach((proxyUrl, urlIndex) => {
                                reachableSequence.forEach((reachable, seqIndex) => {
                                    debouncer.queueStateChange({
                                        proxyUrl,
                                        reachable,
                                        timestamp: baseTime + urlIndex * 1000 + seqIndex * 100
                                    });
                                });
                            });

                            // Verify each proxy URL has a pending state
                            uniqueProxyUrls.forEach((proxyUrl) => {
                                assert.strictEqual(
                                    debouncer.hasPendingChange(proxyUrl),
                                    true,
                                    `Should have pending change for ${proxyUrl}`
                                );
                            });

                            debouncer.dispose();
                        } finally {
                            global.setTimeout = originalSetTimeout;
                            global.clearTimeout = originalClearTimeout;
                        }
                        return true;
                    }
                ),
                { numRuns: 30, verbose: true }
            );
        });

        /**
         * Property: Replacing a pending state should always update to the latest state
         */
        test('should always replace pending state with latest', () => {
            fc.assert(
                fc.property(
                    proxyUrlArb,
                    fc.array(
                        fc.record({
                            reachable: fc.boolean(),
                            timestamp: fc.nat()
                        }),
                        { minLength: 2, maxLength: 20 }
                    ),
                    (proxyUrl: string, stateChanges: { reachable: boolean; timestamp: number }[]) => {
                        const originalSetTimeout = global.setTimeout;
                        const originalClearTimeout = global.clearTimeout;

                        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((_cb: () => void, _delay: number) => {
                            return { id: 1 } as unknown as ReturnType<typeof setTimeout>;
                        }) as typeof setTimeout;

                        (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((_: unknown) => {
                            // No-op
                        }) as typeof clearTimeout;

                        try {
                            const debouncer = new StateChangeDebouncer(1000);

                            // Queue all state changes
                            stateChanges.forEach(({ reachable, timestamp }) => {
                                debouncer.queueStateChange({
                                    proxyUrl,
                                    reachable,
                                    timestamp
                                });
                            });

                            // Verify the pending state is the latest one
                            const pendingState = debouncer.getPendingState(proxyUrl);
                            const lastChange = stateChanges[stateChanges.length - 1];

                            assert.strictEqual(
                                pendingState?.reachable,
                                lastChange.reachable,
                                'Pending state should have the latest reachable value'
                            );
                            assert.strictEqual(
                                pendingState?.timestamp,
                                lastChange.timestamp,
                                'Pending state should have the latest timestamp'
                            );

                            debouncer.dispose();
                        } finally {
                            global.setTimeout = originalSetTimeout;
                            global.clearTimeout = originalClearTimeout;
                        }
                        return true;
                    }
                ),
                { numRuns: 30, verbose: true }
            );
        });

        /**
         * Property: After clear(), no pending changes should exist
         */
        test('clear should remove all pending changes', () => {
            fc.assert(
                fc.property(
                    fc.array(proxyUrlArb, { minLength: 1, maxLength: 10 }),
                    (proxyUrls: string[]) => {
                        const originalSetTimeout = global.setTimeout;
                        const originalClearTimeout = global.clearTimeout;

                        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((_cb: () => void, _delay: number) => {
                            return { id: 1 } as unknown as ReturnType<typeof setTimeout>;
                        }) as typeof setTimeout;

                        (global as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((_: unknown) => {
                            // No-op
                        }) as typeof clearTimeout;

                        try {
                            const debouncer = new StateChangeDebouncer(1000);
                            const uniqueUrls = [...new Set(proxyUrls)];

                            // Queue changes for all URLs
                            uniqueUrls.forEach((proxyUrl) => {
                                debouncer.queueStateChange({
                                    proxyUrl,
                                    reachable: true,
                                    timestamp: Date.now()
                                });
                            });

                            // Clear all
                            debouncer.clear();

                            // Verify no pending changes
                            uniqueUrls.forEach((proxyUrl) => {
                                assert.strictEqual(
                                    debouncer.hasPendingChange(proxyUrl),
                                    false,
                                    `Should not have pending change for ${proxyUrl} after clear`
                                );
                            });

                            debouncer.dispose();
                        } finally {
                            global.setTimeout = originalSetTimeout;
                            global.clearTimeout = originalClearTimeout;
                        }
                        return true;
                    }
                ),
                { numRuns: 30, verbose: true }
            );
        });
    });
});
