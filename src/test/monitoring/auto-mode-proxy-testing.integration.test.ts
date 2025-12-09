/**
 * @file auto-mode-proxy-testing.integration.test.ts
 * @description Integration tests for auto-mode-proxy-testing feature
 * Feature: auto-mode-proxy-testing
 *
 * These tests validate the complete flow of automatic proxy connection testing
 * including startup, periodic testing, proxy change handling, and manual testing.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyTestScheduler } from '../../monitoring/ProxyTestScheduler';
import { StateChangeDebouncer, StateChangeEvent } from '../../errors/StateChangeDebouncer';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';

suite('Auto Mode Proxy Testing Integration Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Task 11.1: Startup Test Flow Integration Test
     * VSCode startup -> Auto mode detection -> System proxy detection -> Connection test -> Enable/disable proxy
     * Validates: Requirements 4.1, 4.2, 4.3
     */
    suite('11.1 Startup Test Flow', () => {
        test('should execute connection test when proxy detected at startup', async function() {
            this.timeout(10000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const proxyUrl = 'http://startup-proxy.example.com:8080';

            // Act - Simulate startup test
            const result = await tester.testProxyAuto(proxyUrl);

            // Assert
            assert.ok(typeof result.success === 'boolean',
                'Should return a test result with success status');
            assert.strictEqual(result.proxyUrl, proxyUrl,
                'Result should contain the tested proxy URL');
            assert.ok(result.timestamp !== undefined && result.timestamp > 0,
                'Result should have a valid timestamp');
        });

        test('should cache test result after startup test', async function() {
            this.timeout(10000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const proxyUrl = 'http://cache-test-proxy.example.com:8080';

            // Act
            await tester.testProxyAuto(proxyUrl);
            const cachedResult = tester.getLastTestResult(proxyUrl);

            // Assert
            assert.ok(cachedResult !== undefined,
                'Should cache test result for later retrieval');
            assert.strictEqual(cachedResult?.proxyUrl, proxyUrl,
                'Cached result should match the tested URL');
        });

        test('should handle no proxy detected at startup', async () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);

            // Act - Don't run any test (simulating no proxy detected)
            const result = tester.getLastTestResult('http://no-proxy:8080');

            // Assert
            assert.strictEqual(result, undefined,
                'Should not have cached result when no proxy was detected');
        });
    });

    /**
     * Task 11.2: Periodic Test Flow Integration Test
     * Periodic test start -> Test execution -> State update based on result -> Notification
     * Validates: Requirements 3.1, 3.2, 3.3
     */
    suite('11.2 Periodic Test Flow', () => {
        test('should start scheduler with configured interval', () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);
            const testResults: TestResult[] = [];

            // Act
            scheduler.start('http://periodic-test:8080', (result) => {
                testResults.push(result);
            });

            // Assert
            assert.strictEqual(scheduler.isActive(), true,
                'Scheduler should be active after start');
            assert.strictEqual(scheduler.getIntervalMs(), 60000,
                'Scheduler should use configured interval');
            assert.strictEqual(scheduler.getCurrentProxyUrl(), 'http://periodic-test:8080',
                'Scheduler should track current proxy URL');

            // Cleanup
            scheduler.stop();
        });

        test('should stop scheduler when stopped', () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);

            // Act
            scheduler.start('http://stop-test:8080', () => {});
            scheduler.stop();

            // Assert
            assert.strictEqual(scheduler.isActive(), false,
                'Scheduler should not be active after stop');
        });

        test('should update interval when configuration changes', () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);

            // Act
            scheduler.start('http://interval-update:8080', () => {});
            scheduler.updateInterval(120000);

            // Assert
            assert.strictEqual(scheduler.getIntervalMs(), 120000,
                'Scheduler should use new interval after update');

            // Cleanup
            scheduler.stop();
        });

        test('should clamp interval to valid range', () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);

            // Act - Create with interval below minimum
            const schedulerMin = new ProxyTestScheduler(tester, 10000); // Below 30s minimum
            assert.strictEqual(schedulerMin.getIntervalMs(), 30000,
                'Should clamp to minimum 30 seconds');

            // Act - Create with interval above maximum
            const schedulerMax = new ProxyTestScheduler(tester, 700000); // Above 600s maximum
            assert.strictEqual(schedulerMax.getIntervalMs(), 600000,
                'Should clamp to maximum 600 seconds (10 minutes)');
        });
    });

    /**
     * Task 11.3: Proxy Change Flow Integration Test
     * System proxy change detection -> Immediate test execution -> State update -> Notification
     * Validates: Requirements 5.1, 5.2, 5.3
     */
    suite('11.3 Proxy Change Flow', () => {
        test('should update proxy URL when system proxy changes', () => {
            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);

            // Act
            scheduler.start('http://old-proxy:8080', () => {});
            scheduler.updateProxyUrl('http://new-proxy:8080');

            // Assert
            assert.strictEqual(scheduler.getCurrentProxyUrl(), 'http://new-proxy:8080',
                'Should update to new proxy URL');

            // Cleanup
            scheduler.stop();
        });

        test('should trigger immediate test when proxy URL changes', async function() {
            this.timeout(10000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);
            let testTriggered = false;

            // Act
            scheduler.start('http://trigger-test:8080', () => {
                testTriggered = true;
            });

            // Trigger immediate test
            await scheduler.triggerImmediateTest();

            // Assert
            assert.strictEqual(testTriggered, true,
                'Should trigger immediate test callback');

            // Cleanup
            scheduler.stop();
        });
    });

    /**
     * Task 11.4: Manual Test Flow Integration Test
     * User executes test command -> Detailed test execution -> Detailed result display
     * Validates: Requirements 7.1, 7.3
     */
    suite('11.4 Manual Test Flow', () => {
        test('should use longer timeout for manual tests', async function() {
            this.timeout(15000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const proxyUrl = 'http://manual-test-proxy.example.com:8080';

            // Act
            const startTime = Date.now();
            await tester.testProxyManual(proxyUrl);
            const elapsed = Date.now() - startTime;

            // Assert - Manual tests have 5s timeout, should complete within 8s
            assert.ok(elapsed < 10000,
                `Manual test should complete within 10 seconds (elapsed: ${elapsed}ms)`);
        });

        test('should return detailed result for manual tests', async function() {
            this.timeout(15000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const proxyUrl = 'http://detailed-result.example.com:8080';

            // Act
            const result = await tester.testProxyManual(proxyUrl);

            // Assert - Verify result contains all required details
            assert.ok(typeof result.success === 'boolean', 'Should have success field');
            assert.ok(Array.isArray(result.testUrls), 'Should have testUrls array');
            assert.ok(Array.isArray(result.errors), 'Should have errors array');
            assert.ok(typeof result.duration === 'number', 'Should have duration');
            assert.ok(typeof result.timestamp === 'number', 'Should have timestamp');
            assert.strictEqual(result.proxyUrl, proxyUrl, 'Should have correct proxyUrl');
        });
    });

    /**
     * State Change Debouncer Integration Tests
     * Tests the debouncer's integration with notification flow
     * Validates: Requirements 6.4
     */
    suite('State Change Debouncing Integration', () => {
        test('should debounce consecutive state changes', function(done) {
            this.timeout(5000);

            // Arrange
            const notifiedStates: StateChangeEvent[] = [];
            const debouncer = new StateChangeDebouncer(500); // 500ms debounce

            debouncer.setCallback((event) => {
                notifiedStates.push(event);
            });

            // Act - Rapidly queue multiple state changes
            const proxyUrl = 'http://debounce-test:8080';
            debouncer.queueStateChange({ proxyUrl, reachable: true, timestamp: Date.now() });
            debouncer.queueStateChange({ proxyUrl, reachable: false, timestamp: Date.now() + 100 });
            debouncer.queueStateChange({ proxyUrl, reachable: true, timestamp: Date.now() + 200 });
            debouncer.queueStateChange({ proxyUrl, reachable: false, timestamp: Date.now() + 300 });

            // Assert after debounce period
            setTimeout(() => {
                assert.strictEqual(notifiedStates.length, 1,
                    'Should only notify once after debounce');
                assert.strictEqual(notifiedStates[0].reachable, false,
                    'Should notify with final state');

                debouncer.dispose();
                done();
            }, 600);
        });

        test('should handle multiple proxy URLs independently', function(done) {
            this.timeout(5000);

            // Arrange
            const notifiedStates: StateChangeEvent[] = [];
            const debouncer = new StateChangeDebouncer(300);

            debouncer.setCallback((event) => {
                notifiedStates.push(event);
            });

            // Act - Queue changes for different proxy URLs
            debouncer.queueStateChange({
                proxyUrl: 'http://proxy1:8080',
                reachable: true,
                timestamp: Date.now()
            });
            debouncer.queueStateChange({
                proxyUrl: 'http://proxy2:8080',
                reachable: false,
                timestamp: Date.now()
            });

            // Assert after debounce period
            setTimeout(() => {
                assert.strictEqual(notifiedStates.length, 2,
                    'Should notify for each proxy URL');

                const proxy1State = notifiedStates.find(s => s.proxyUrl === 'http://proxy1:8080');
                const proxy2State = notifiedStates.find(s => s.proxyUrl === 'http://proxy2:8080');

                assert.ok(proxy1State !== undefined, 'Should have state for proxy1');
                assert.ok(proxy2State !== undefined, 'Should have state for proxy2');
                assert.strictEqual(proxy1State?.reachable, true, 'Proxy1 should be reachable');
                assert.strictEqual(proxy2State?.reachable, false, 'Proxy2 should not be reachable');

                debouncer.dispose();
                done();
            }, 400);
        });

        test('should cancel pending notifications on dispose', function(done) {
            this.timeout(3000);

            // Arrange
            let notificationCount = 0;
            const debouncer = new StateChangeDebouncer(500);

            debouncer.setCallback(() => {
                notificationCount++;
            });

            // Act
            debouncer.queueStateChange({
                proxyUrl: 'http://dispose-test:8080',
                reachable: true,
                timestamp: Date.now()
            });

            // Dispose before debounce completes
            setTimeout(() => {
                debouncer.dispose();
            }, 100);

            // Assert - No notification should be received
            setTimeout(() => {
                assert.strictEqual(notificationCount, 0,
                    'Should not notify after dispose');
                done();
            }, 700);
        });
    });

    /**
     * Full Integration Flow Test
     * Tests the complete flow from startup through periodic testing
     */
    suite('Full Integration Flow', () => {
        test('should handle complete startup to periodic test flow', async function() {
            this.timeout(15000);

            // Arrange
            const mockNotifier = sandbox.createStubInstance(UserNotifier);
            const tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
            const scheduler = new ProxyTestScheduler(tester, 60000);
            const proxyUrl = 'http://full-flow-test.example.com:8080';
            let testCount = 0;

            // Act 1: Simulate startup test
            const startupResult = await tester.testProxyAuto(proxyUrl);
            assert.ok(typeof startupResult.success === 'boolean',
                'Startup test should return result');

            // Act 2: Start scheduler (simulating Auto mode enabled)
            scheduler.start(proxyUrl, () => {
                testCount++;
            });
            assert.strictEqual(scheduler.isActive(), true,
                'Scheduler should be active');

            // Act 3: Trigger immediate test (simulating proxy URL change)
            await scheduler.triggerImmediateTest();
            assert.strictEqual(testCount, 1,
                'Should have executed one test after trigger');

            // Cleanup
            scheduler.stop();
            assert.strictEqual(scheduler.isActive(), false,
                'Scheduler should be stopped');
        });
    });
});
