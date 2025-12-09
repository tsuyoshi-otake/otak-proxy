/**
 * @file ProxyChangeLogger Fallback Tests
 * @description Tests for ProxyChangeLogger fallback logging
 * Feature: auto-mode-fallback-improvements
 * Tasks: 6.1-6.5
 *
 * Validates:
 * - Task 6.1: ProxyChangeLogger extension for fallback logging
 * - Task 6.2: Unit tests for fallback logging
 * - Task 6.3: Property test for fallback log (Property 13)
 * - Task 6.4: Property test for Auto Mode OFF log (Property 14)
 * - Task 6.5: Property test for system proxy return log (Property 15)
 * - Requirements 7.2, 7.3, 7.4
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fc from 'fast-check';
import { ProxyChangeLogger, FallbackLogEvent } from '../../monitoring/ProxyChangeLogger';
import { getPropertyTestRuns } from '../helpers';
import { proxyUrlArb } from '../generators';

suite('ProxyChangeLogger Fallback Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let logger: ProxyChangeLogger;
    let mockSanitizer: { maskPassword: (url: string) => string };

    setup(() => {
        sandbox = sinon.createSandbox();
        mockSanitizer = {
            maskPassword: (url: string) => url.replace(/:([^@]+)@/, ':***@')
        };
        logger = new ProxyChangeLogger(mockSanitizer);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Task 6.1: ProxyChangeLogger extension for fallback logging
     * Task 6.2: Unit tests for fallback logging
     * Validates: Requirements 7.2, 7.3, 7.4
     */
    suite('Task 6.1-6.2: Fallback Logging', () => {
        test('should log "Fallback to Manual Proxy" (Requirement 7.2)', () => {
            const fallbackProxy = 'http://manual-proxy.example.com:8080';

            logger.logFallbackToManual(null, fallbackProxy);

            const lastEvent = logger.getLastFallbackEvent();
            assert.ok(lastEvent !== null);
            assert.strictEqual(lastEvent!.type, 'fallback');
            assert.strictEqual(lastEvent!.message, 'Fallback to Manual Proxy');
            assert.strictEqual(lastEvent!.newProxy, fallbackProxy);
        });

        test('should log "Auto Mode OFF (waiting for proxy)" (Requirement 7.3)', () => {
            const lastProxy = 'http://last-proxy.example.com:8080';

            logger.logAutoModeOff(lastProxy);

            const lastEvent = logger.getLastFallbackEvent();
            assert.ok(lastEvent !== null);
            assert.strictEqual(lastEvent!.type, 'auto-mode-off');
            assert.strictEqual(lastEvent!.message, 'Auto Mode OFF (waiting for proxy)');
            assert.strictEqual(lastEvent!.previousProxy, lastProxy);
            assert.strictEqual(lastEvent!.newProxy, null);
        });

        test('should log "Switched back to System Proxy" (Requirement 7.4)', () => {
            const fallbackProxy = 'http://fallback.example.com:8080';
            const systemProxy = 'http://system.example.com:8080';

            logger.logSystemReturn(fallbackProxy, systemProxy);

            const lastEvent = logger.getLastFallbackEvent();
            assert.ok(lastEvent !== null);
            assert.strictEqual(lastEvent!.type, 'system-return');
            assert.strictEqual(lastEvent!.message, 'Switched back to System Proxy');
            assert.strictEqual(lastEvent!.previousProxy, fallbackProxy);
            assert.strictEqual(lastEvent!.newProxy, systemProxy);
        });

        test('should maintain fallback history', () => {
            logger.logFallbackToManual(null, 'http://proxy1.example.com:8080');
            logger.logAutoModeOff('http://proxy1.example.com:8080');
            logger.logSystemReturn(null, 'http://system.example.com:8080');

            const history = logger.getFallbackHistory();
            assert.strictEqual(history.length, 3);
            assert.strictEqual(history[0].type, 'fallback');
            assert.strictEqual(history[1].type, 'auto-mode-off');
            assert.strictEqual(history[2].type, 'system-return');
        });

        test('should limit fallback history size', () => {
            // Log more than max history size
            for (let i = 0; i < 150; i++) {
                logger.logFallbackToManual(null, `http://proxy${i}.example.com:8080`);
            }

            const history = logger.getFallbackHistory();
            assert.ok(history.length <= 100,
                'History should be limited to max size');
        });

        test('should clear fallback history', () => {
            logger.logFallbackToManual(null, 'http://proxy.example.com:8080');
            logger.logAutoModeOff(null);

            logger.clearFallbackHistory();

            const history = logger.getFallbackHistory();
            assert.strictEqual(history.length, 0);
        });

        test('should sanitize proxy URLs with credentials', () => {
            const proxyWithCreds = 'http://user:password@proxy.example.com:8080';

            logger.logFallbackToManual(null, proxyWithCreds);

            const lastEvent = logger.getLastFallbackEvent();
            assert.ok(lastEvent !== null);
            // Password should be masked
            assert.ok(lastEvent!.newProxy!.includes(':***@'),
                'Password should be masked');
        });
    });

    /**
     * Task 6.3: Property test for fallback log
     * Property 13: Fallback usage log
     * Validates: Requirements 7.2
     */
    suite('Property 13: Fallback usage log', () => {
        test('should always log fallback with correct message', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }),
                    proxyUrlArb,
                    async (previousProxy, fallbackProxy) => {
                        logger.clearFallbackHistory();

                        logger.logFallbackToManual(previousProxy, fallbackProxy);

                        const lastEvent = logger.getLastFallbackEvent();
                        assert.ok(lastEvent !== null,
                            'Fallback event should be logged');
                        assert.strictEqual(lastEvent!.type, 'fallback',
                            'Event type should be fallback');
                        assert.strictEqual(lastEvent!.message, 'Fallback to Manual Proxy',
                            'Message should be "Fallback to Manual Proxy"');
                        assert.ok(lastEvent!.timestamp > 0,
                            'Timestamp should be set');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 6.4: Property test for Auto Mode OFF log
     * Property 14: Auto Mode OFF log
     * Validates: Requirements 7.3
     */
    suite('Property 14: Auto Mode OFF log', () => {
        test('should always log Auto Mode OFF with correct message', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }),
                    async (lastProxy) => {
                        logger.clearFallbackHistory();

                        logger.logAutoModeOff(lastProxy);

                        const lastEvent = logger.getLastFallbackEvent();
                        assert.ok(lastEvent !== null,
                            'Auto Mode OFF event should be logged');
                        assert.strictEqual(lastEvent!.type, 'auto-mode-off',
                            'Event type should be auto-mode-off');
                        assert.strictEqual(lastEvent!.message, 'Auto Mode OFF (waiting for proxy)',
                            'Message should be "Auto Mode OFF (waiting for proxy)"');
                        assert.strictEqual(lastEvent!.newProxy, null,
                            'New proxy should be null');
                    }
                ),
                { numRuns }
            );
        });
    });

    /**
     * Task 6.5: Property test for system proxy return log
     * Property 15: System proxy return log
     * Validates: Requirements 7.4
     */
    suite('Property 15: System proxy return log', () => {
        test('should always log system return with correct message', async function() {
            this.timeout(60000);
            const numRuns = getPropertyTestRuns();

            await fc.assert(
                fc.asyncProperty(
                    fc.option(proxyUrlArb, { nil: null }),
                    proxyUrlArb,
                    async (fallbackProxy, systemProxy) => {
                        logger.clearFallbackHistory();

                        logger.logSystemReturn(fallbackProxy, systemProxy);

                        const lastEvent = logger.getLastFallbackEvent();
                        assert.ok(lastEvent !== null,
                            'System return event should be logged');
                        assert.strictEqual(lastEvent!.type, 'system-return',
                            'Event type should be system-return');
                        assert.strictEqual(lastEvent!.message, 'Switched back to System Proxy',
                            'Message should be "Switched back to System Proxy"');
                    }
                ),
                { numRuns }
            );
        });
    });
});
