/**
 * @file ProxyTestScheduler Unit Tests
 * @description Tests for ProxyTestScheduler class
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 3.1, 3.4, 8.2
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyTestScheduler } from '../../monitoring/ProxyTestScheduler';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../../errors/UserNotifier';
import { TestResult } from '../../utils/ProxyUtils';

suite('ProxyTestScheduler Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let tester: ProxyConnectionTester;
    let scheduler: ProxyTestScheduler;
    let clock: sinon.SinonFakeTimers;

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers();
        mockNotifier = sandbox.createStubInstance(UserNotifier);
        tester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
        scheduler = new ProxyTestScheduler(tester, 60000); // 60 second default interval
    });

    teardown(() => {
        scheduler.stop();
        clock.restore();
        sandbox.restore();
    });

    suite('Constructor', () => {
        test('should create instance with tester and interval', () => {
            assert.ok(scheduler instanceof ProxyTestScheduler,
                'Should create ProxyTestScheduler instance');
        });

        test('should initialize as inactive', () => {
            assert.strictEqual(scheduler.isActive(), false,
                'Should be inactive initially');
        });
    });

    suite('start', () => {
        test('should start scheduler and set active', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);

            assert.strictEqual(scheduler.isActive(), true,
                'Should be active after start');
        });

        test('should store proxy URL', () => {
            const callback = sandbox.stub();
            const proxyUrl = 'http://proxy:8080';
            scheduler.start(proxyUrl, callback);

            assert.strictEqual(scheduler.getCurrentProxyUrl(), proxyUrl,
                'Should store proxy URL');
        });

        test('should execute callback on interval', async function() {
            this.timeout(5000);

            const callback = sandbox.stub();

            // Mock the tester to return immediately
            const mockResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy:8080',
                timestamp: Date.now(),
                duration: 100
            };
            sandbox.stub(tester, 'testProxyAuto').resolves(mockResult);

            scheduler.start('http://proxy:8080', callback);

            // Fast-forward time by one interval
            await clock.tickAsync(60000);

            // Callback should have been called
            assert.ok(callback.called, 'Callback should be called after interval');
        });
    });

    suite('stop', () => {
        test('should stop scheduler and set inactive', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);
            scheduler.stop();

            assert.strictEqual(scheduler.isActive(), false,
                'Should be inactive after stop');
        });

        test('should clear interval timer', async () => {
            const callback = sandbox.stub();
            sandbox.stub(tester, 'testProxyAuto').resolves({
                success: true,
                testUrls: [],
                errors: [],
                proxyUrl: 'http://proxy:8080',
                timestamp: Date.now(),
                duration: 100
            });

            scheduler.start('http://proxy:8080', callback);
            scheduler.stop();

            // Fast-forward time - callback should not be called
            await clock.tickAsync(120000);

            assert.strictEqual(callback.callCount, 0,
                'Callback should not be called after stop');
        });
    });

    suite('updateInterval', () => {
        test('should update interval time', () => {
            scheduler.updateInterval(30000);

            assert.strictEqual(scheduler.getIntervalMs(), 30000,
                'Should update interval');
        });

        test('should restart timer with new interval when active', async () => {
            const callback = sandbox.stub();
            sandbox.stub(tester, 'testProxyAuto').resolves({
                success: true,
                testUrls: [],
                errors: [],
                proxyUrl: 'http://proxy:8080',
                timestamp: Date.now(),
                duration: 100
            });

            scheduler.start('http://proxy:8080', callback);

            // Update to shorter interval
            scheduler.updateInterval(30000);

            // Fast-forward by new interval
            await clock.tickAsync(30000);

            assert.ok(callback.called, 'Callback should be called with new interval');
        });
    });

    suite('updateProxyUrl', () => {
        test('should update proxy URL', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);

            scheduler.updateProxyUrl('http://new-proxy:8080');

            assert.strictEqual(scheduler.getCurrentProxyUrl(), 'http://new-proxy:8080',
                'Should update proxy URL');
        });
    });

    suite('triggerImmediateTest', () => {
        test('should execute test immediately', async function() {
            this.timeout(5000);

            const callback = sandbox.stub();
            const mockResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy:8080',
                timestamp: Date.now(),
                duration: 100
            };
            const testStub = sandbox.stub(tester, 'testProxyAuto').resolves(mockResult);

            scheduler.start('http://proxy:8080', callback);
            await scheduler.triggerImmediateTest();

            assert.ok(testStub.called, 'testProxyAuto should be called immediately');
            assert.ok(callback.called, 'Callback should be called immediately');
        });

        test('should do nothing if not active', async () => {
            const testStub = sandbox.stub(tester, 'testProxyAuto');

            await scheduler.triggerImmediateTest();

            assert.strictEqual(testStub.callCount, 0,
                'Should not test if scheduler is not active');
        });
    });

    suite('isActive', () => {
        test('should return false when not started', () => {
            assert.strictEqual(scheduler.isActive(), false);
        });

        test('should return true when started', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);

            assert.strictEqual(scheduler.isActive(), true);
        });

        test('should return false after stop', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);
            scheduler.stop();

            assert.strictEqual(scheduler.isActive(), false);
        });
    });

    suite('getIntervalMs', () => {
        test('should return initial interval', () => {
            assert.strictEqual(scheduler.getIntervalMs(), 60000);
        });

        test('should return updated interval', () => {
            scheduler.updateInterval(120000);

            assert.strictEqual(scheduler.getIntervalMs(), 120000);
        });
    });

    suite('getCurrentProxyUrl', () => {
        test('should return undefined when not started', () => {
            assert.strictEqual(scheduler.getCurrentProxyUrl(), undefined);
        });

        test('should return proxy URL when started', () => {
            const callback = sandbox.stub();
            scheduler.start('http://proxy:8080', callback);

            assert.strictEqual(scheduler.getCurrentProxyUrl(), 'http://proxy:8080');
        });
    });
});
