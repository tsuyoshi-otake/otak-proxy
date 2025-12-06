/**
 * Unit tests for ProxyChangeLogger
 * Tests proxy change and check event logging with credential masking
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyChangeLogger, ProxyChangeEvent, ProxyCheckEvent } from '../monitoring/ProxyChangeLogger';
import { InputSanitizer } from '../validation/InputSanitizer';
import { urlWithCredentialsGenerator } from './generators';

suite('ProxyChangeLogger Test Suite', () => {
    let logger: ProxyChangeLogger;
    let sanitizer: InputSanitizer;

    setup(() => {
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);
    });

    suite('constructor', () => {
        test('should initialize with empty history', () => {
            assert.strictEqual(logger.getChangeHistory().length, 0);
            assert.strictEqual(logger.getCheckHistory().length, 0);
        });
    });

    suite('logChange', () => {
        test('should record a proxy change event', () => {
            const event: ProxyChangeEvent = {
                timestamp: Date.now(),
                previousProxy: 'http://old-proxy.example.com:8080',
                newProxy: 'http://new-proxy.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            };

            logger.logChange(event);

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 1);
            // URL.toString() adds trailing slash, so we normalize for comparison
            assert.ok(history[0].previousProxy === 'http://old-proxy.example.com:8080' || history[0].previousProxy === 'http://old-proxy.example.com:8080/');
            assert.ok(history[0].newProxy === 'http://new-proxy.example.com:8080' || history[0].newProxy === 'http://new-proxy.example.com:8080/');
            assert.strictEqual(history[0].source, 'environment');
            assert.strictEqual(history[0].trigger, 'polling');
        });

        test('should mask credentials in proxy URLs', () => {
            const event: ProxyChangeEvent = {
                timestamp: Date.now(),
                previousProxy: 'http://user:password@old-proxy.example.com:8080',
                newProxy: 'http://admin:secret@new-proxy.example.com:8080',
                source: 'vscode',
                trigger: 'focus'
            };

            logger.logChange(event);

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 1);
            // Passwords should be masked
            assert.ok(history[0].previousProxy!.includes('****'));
            assert.ok(!history[0].previousProxy!.includes('password'));
            assert.ok(history[0].newProxy!.includes('****'));
            assert.ok(!history[0].newProxy!.includes('secret'));
        });

        test('should handle null proxy values', () => {
            const event: ProxyChangeEvent = {
                timestamp: Date.now(),
                previousProxy: null,
                newProxy: 'http://proxy.example.com:8080',
                source: 'platform',
                trigger: 'network'
            };

            logger.logChange(event);

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].previousProxy, null);
            // URL.toString() adds trailing slash
            assert.ok(history[0].newProxy === 'http://proxy.example.com:8080' || history[0].newProxy === 'http://proxy.example.com:8080/');
        });

        test('should record proxy removal event', () => {
            const event: ProxyChangeEvent = {
                timestamp: Date.now(),
                previousProxy: 'http://proxy.example.com:8080',
                newProxy: null,
                source: 'environment',
                trigger: 'config'
            };

            logger.logChange(event);

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 1);
            // URL.toString() adds trailing slash
            assert.ok(history[0].previousProxy === 'http://proxy.example.com:8080' || history[0].previousProxy === 'http://proxy.example.com:8080/');
            assert.strictEqual(history[0].newProxy, null);
        });
    });

    suite('logCheck', () => {
        test('should record a successful check event', () => {
            const event: ProxyCheckEvent = {
                timestamp: Date.now(),
                success: true,
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            };

            logger.logCheck(event);

            const history = logger.getCheckHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].success, true);
            // URL.toString() adds trailing slash
            assert.ok(history[0].proxyUrl === 'http://proxy.example.com:8080' || history[0].proxyUrl === 'http://proxy.example.com:8080/');
            assert.strictEqual(history[0].source, 'environment');
        });

        test('should record a failed check event with error', () => {
            const event: ProxyCheckEvent = {
                timestamp: Date.now(),
                success: false,
                proxyUrl: null,
                source: null,
                error: 'Detection timeout',
                trigger: 'focus'
            };

            logger.logCheck(event);

            const history = logger.getCheckHistory();
            assert.strictEqual(history.length, 1);
            assert.strictEqual(history[0].success, false);
            assert.strictEqual(history[0].error, 'Detection timeout');
        });

        test('should mask credentials in check event proxy URL', () => {
            const event: ProxyCheckEvent = {
                timestamp: Date.now(),
                success: true,
                proxyUrl: 'http://user:password@proxy.example.com:8080',
                source: 'vscode',
                trigger: 'config'
            };

            logger.logCheck(event);

            const history = logger.getCheckHistory();
            assert.strictEqual(history.length, 1);
            assert.ok(history[0].proxyUrl!.includes('****'));
            assert.ok(!history[0].proxyUrl!.includes('password'));
        });
    });

    suite('getChangeHistory', () => {
        test('should return all events when no limit specified', () => {
            for (let i = 0; i < 5; i++) {
                logger.logChange({
                    timestamp: Date.now() + i,
                    previousProxy: null,
                    newProxy: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 5);
        });

        test('should respect limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                logger.logChange({
                    timestamp: Date.now() + i,
                    previousProxy: null,
                    newProxy: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getChangeHistory(3);
            assert.strictEqual(history.length, 3);
        });

        test('should return copy of history (immutable)', () => {
            logger.logChange({
                timestamp: Date.now(),
                previousProxy: null,
                newProxy: 'http://proxy.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            });

            const history1 = logger.getChangeHistory();
            const history2 = logger.getChangeHistory();
            assert.notStrictEqual(history1, history2);
        });
    });

    suite('getCheckHistory', () => {
        test('should return all events when no limit specified', () => {
            for (let i = 0; i < 5; i++) {
                logger.logCheck({
                    timestamp: Date.now() + i,
                    success: true,
                    proxyUrl: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getCheckHistory();
            assert.strictEqual(history.length, 5);
        });

        test('should respect limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                logger.logCheck({
                    timestamp: Date.now() + i,
                    success: true,
                    proxyUrl: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getCheckHistory(3);
            assert.strictEqual(history.length, 3);
        });
    });

    suite('clearHistory', () => {
        test('should clear both change and check history', () => {
            logger.logChange({
                timestamp: Date.now(),
                previousProxy: null,
                newProxy: 'http://proxy.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            });
            logger.logCheck({
                timestamp: Date.now(),
                success: true,
                proxyUrl: 'http://proxy.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            });

            assert.strictEqual(logger.getChangeHistory().length, 1);
            assert.strictEqual(logger.getCheckHistory().length, 1);

            logger.clearHistory();

            assert.strictEqual(logger.getChangeHistory().length, 0);
            assert.strictEqual(logger.getCheckHistory().length, 0);
        });
    });

    suite('getLastChange', () => {
        test('should return null when no events', () => {
            assert.strictEqual(logger.getLastChange(), null);
        });

        test('should return the most recent change event', () => {
            logger.logChange({
                timestamp: 1000,
                previousProxy: null,
                newProxy: 'http://proxy1.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            });
            logger.logChange({
                timestamp: 2000,
                previousProxy: 'http://proxy1.example.com:8080',
                newProxy: 'http://proxy2.example.com:8080',
                source: 'vscode',
                trigger: 'focus'
            });

            const lastChange = logger.getLastChange();
            assert.ok(lastChange !== null);
            // URL.toString() adds trailing slash
            assert.ok(lastChange!.newProxy === 'http://proxy2.example.com:8080' || lastChange!.newProxy === 'http://proxy2.example.com:8080/');
        });
    });

    suite('getLastCheck', () => {
        test('should return null when no events', () => {
            assert.strictEqual(logger.getLastCheck(), null);
        });

        test('should return the most recent check event', () => {
            logger.logCheck({
                timestamp: 1000,
                success: true,
                proxyUrl: 'http://proxy1.example.com:8080',
                source: 'environment',
                trigger: 'polling'
            });
            logger.logCheck({
                timestamp: 2000,
                success: false,
                proxyUrl: null,
                source: null,
                error: 'Failed',
                trigger: 'focus'
            });

            const lastCheck = logger.getLastCheck();
            assert.ok(lastCheck !== null);
            assert.strictEqual(lastCheck!.success, false);
            assert.strictEqual(lastCheck!.error, 'Failed');
        });
    });

    suite('history size limit', () => {
        test('should enforce maximum history size for change events', () => {
            // Add more than 100 events
            for (let i = 0; i < 110; i++) {
                logger.logChange({
                    timestamp: Date.now() + i,
                    previousProxy: null,
                    newProxy: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getChangeHistory();
            assert.strictEqual(history.length, 100);
        });

        test('should enforce maximum history size for check events', () => {
            // Add more than 100 events
            for (let i = 0; i < 110; i++) {
                logger.logCheck({
                    timestamp: Date.now() + i,
                    success: true,
                    proxyUrl: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getCheckHistory();
            assert.strictEqual(history.length, 100);
        });

        test('should keep newest events when limit is exceeded', () => {
            // Add events with sequential timestamps
            for (let i = 0; i < 110; i++) {
                logger.logChange({
                    timestamp: i,
                    previousProxy: null,
                    newProxy: `http://proxy${i}.example.com:8080`,
                    source: 'environment',
                    trigger: 'polling'
                });
            }

            const history = logger.getChangeHistory();
            // The oldest events (0-9) should have been removed
            // The newest events (10-109) should be kept
            assert.strictEqual(history[0].timestamp, 10);
            assert.strictEqual(history[99].timestamp, 109);
        });
    });

    suite('Property-Based Tests', () => {
        /**
         * Feature: auto-proxy-detection-improvements, Property 11: ログ記録時のクレデンシャルマスキング
         * 任意のクレデンシャル付きプロキシURLに対して、ログに記録される値がマスクされていることを検証
         * Validates: Requirements 4.4
         */
        test('Property 11: Credentials are masked in logged change events', async function() {
            this.timeout(10000);

            await fc.assert(
                fc.asyncProperty(
                    urlWithCredentialsGenerator(),
                    fc.constantFrom('polling', 'focus', 'config', 'network'),
                    async (urlWithCreds, trigger) => {
                        // Parse URL to extract password
                        let originalPassword: string | undefined;
                        try {
                            const parsed = new URL(urlWithCreds);
                            originalPassword = parsed.password;
                        } catch {
                            // If URL parsing fails, skip this case
                            return true;
                        }

                        // Skip if no password
                        if (!originalPassword) {
                            return true;
                        }

                        const decodedPassword = decodeURIComponent(originalPassword);

                        // Skip very short passwords (less than 4 chars) as they might appear in masked form
                        if (decodedPassword.length < 4) {
                            return true;
                        }

                        // Skip passwords that contain only characters that could appear in other URL parts
                        // (hyphens, numbers) as they could match hostname parts
                        if (/^[-0-9]+$/.test(decodedPassword)) {
                            return true;
                        }

                        // Test with change event (previousProxy)
                        const changeEvent: ProxyChangeEvent = {
                            timestamp: Date.now(),
                            previousProxy: urlWithCreds,
                            newProxy: 'http://new-proxy.example.com:8080',
                            source: 'environment',
                            trigger: trigger as 'polling' | 'focus' | 'config' | 'network'
                        };

                        logger.logChange(changeEvent);
                        const changeHistory = logger.getChangeHistory();
                        const lastChange = changeHistory[changeHistory.length - 1];

                        // Verify password is not in logged previousProxy
                        assert.ok(
                            !lastChange.previousProxy?.includes(decodedPassword),
                            `Change event previousProxy should not contain password. URL: ${urlWithCreds}, Logged: ${lastChange.previousProxy}`
                        );

                        // Verify masked marker is present
                        assert.ok(
                            lastChange.previousProxy?.includes('****'),
                            `Change event previousProxy should contain **** mask. Logged: ${lastChange.previousProxy}`
                        );

                        // Test with change event (newProxy)
                        const changeEvent2: ProxyChangeEvent = {
                            timestamp: Date.now(),
                            previousProxy: 'http://old-proxy.example.com:8080',
                            newProxy: urlWithCreds,
                            source: 'vscode',
                            trigger: trigger as 'polling' | 'focus' | 'config' | 'network'
                        };

                        logger.logChange(changeEvent2);
                        const changeHistory2 = logger.getChangeHistory();
                        const lastChange2 = changeHistory2[changeHistory2.length - 1];

                        // Verify password is not in logged newProxy
                        assert.ok(
                            !lastChange2.newProxy?.includes(decodedPassword),
                            `Change event newProxy should not contain password. URL: ${urlWithCreds}, Logged: ${lastChange2.newProxy}`
                        );

                        // Verify masked marker is present
                        assert.ok(
                            lastChange2.newProxy?.includes('****'),
                            `Change event newProxy should contain **** mask. Logged: ${lastChange2.newProxy}`
                        );

                        // Test with check event
                        const checkEvent: ProxyCheckEvent = {
                            timestamp: Date.now(),
                            success: true,
                            proxyUrl: urlWithCreds,
                            source: 'environment',
                            trigger: trigger as 'polling' | 'focus' | 'config' | 'network'
                        };

                        logger.logCheck(checkEvent);
                        const checkHistory = logger.getCheckHistory();
                        const lastCheck = checkHistory[checkHistory.length - 1];

                        // Verify password is not in logged proxyUrl
                        assert.ok(
                            !lastCheck.proxyUrl?.includes(decodedPassword),
                            `Check event proxyUrl should not contain password. URL: ${urlWithCreds}, Logged: ${lastCheck.proxyUrl}`
                        );

                        // Verify masked marker is present
                        assert.ok(
                            lastCheck.proxyUrl?.includes('****'),
                            `Check event proxyUrl should contain **** mask. Logged: ${lastCheck.proxyUrl}`
                        );

                        return true;
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
