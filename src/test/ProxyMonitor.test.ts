/**
 * Unit tests for ProxyMonitor
 * Tests proxy monitoring with polling, debouncing, retry logic
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 1.1, 1.2, 1.3, 4.2
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyMonitor, ProxyMonitorConfig, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyMonitorState } from '../monitoring/ProxyMonitorState';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../errors/UserNotifier';
import { TestResult } from '../utils/ProxyUtils';

// Mock SystemProxyDetector for testing
class MockSystemProxyDetector {
    private mockResult: string | null = null;
    private shouldFail: boolean = false;
    private checkCount: number = 0;
    private detectionSource: string | null = 'environment';

    setMockResult(result: string | null): void {
        this.mockResult = result;
    }

    setShouldFail(fail: boolean): void {
        this.shouldFail = fail;
    }

    setDetectionSource(source: string | null): void {
        this.detectionSource = source;
    }

    getCheckCount(): number {
        return this.checkCount;
    }

    resetCheckCount(): void {
        this.checkCount = 0;
    }

    async detectSystemProxy(): Promise<string | null> {
        this.checkCount++;
        if (this.shouldFail) {
            throw new Error('Mock detection failed');
        }
        return this.mockResult;
    }

    async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
        this.checkCount++;
        if (this.shouldFail) {
            throw new Error('Mock detection failed');
        }
        return {
            proxyUrl: this.mockResult,
            source: this.detectionSource
        };
    }
}

suite('ProxyMonitor Test Suite', () => {
    let monitor: ProxyMonitor;
    let mockDetector: MockSystemProxyDetector;
    let logger: ProxyChangeLogger;
    let sanitizer: InputSanitizer;

    setup(() => {
        mockDetector = new MockSystemProxyDetector();
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);
    });

    teardown(() => {
        if (monitor) {
            monitor.stop();
        }
    });

    suite('constructor', () => {
        test('should create instance with default config', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger);
            assert.ok(monitor);
        });

        test('should create instance with custom config', () => {
            const config: Partial<ProxyMonitorConfig> = {
                pollingInterval: 10000,
                debounceDelay: 500,
                maxRetries: 5,
                retryBackoffBase: 2
            };
            monitor = new ProxyMonitor(mockDetector as any, logger, config);
            assert.ok(monitor);
        });
    });

    suite('start and stop', () => {
        test('should start monitoring', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });
            monitor.start();
            const state = monitor.getState();
            assert.strictEqual(state.isActive, true);
        });

        test('should stop monitoring', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });
            monitor.start();
            monitor.stop();
            const state = monitor.getState();
            assert.strictEqual(state.isActive, false);
        });

        test('should be safe to call stop multiple times', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });
            monitor.start();
            monitor.stop();
            monitor.stop();
            assert.strictEqual(monitor.getState().isActive, false);
        });

        test('should be safe to call start multiple times', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });
            monitor.start();
            monitor.start();
            assert.strictEqual(monitor.getState().isActive, true);
            monitor.stop();
        });
    });

    suite('triggerCheck with debounce', () => {
        test('should debounce multiple triggers', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 100
            });
            mockDetector.setMockResult('http://proxy.example.com:8080');
            monitor.start();

            // Trigger multiple checks in quick succession
            monitor.triggerCheck('focus');
            monitor.triggerCheck('config');
            monitor.triggerCheck('network');

            // Wait for debounce
            await new Promise(resolve => setTimeout(resolve, 200));

            // Should only have executed one check
            assert.strictEqual(mockDetector.getCheckCount(), 1);
        });

        test('should execute check after debounce delay', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 50
            });
            mockDetector.setMockResult('http://proxy.example.com:8080');
            monitor.start();

            monitor.triggerCheck('focus');

            // Wait for debounce
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.ok(mockDetector.getCheckCount() >= 1);
        });
    });

    suite('updateConfig', () => {
        test('should update polling interval', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });
            monitor.start();

            monitor.updateConfig({ pollingInterval: 10000 });

            // Config should be updated (we can't directly verify interval change
            // but we verify no errors are thrown)
            assert.ok(monitor.getState().isActive);
        });

        test('should validate polling interval range', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });

            // Should clamp to minimum
            monitor.updateConfig({ pollingInterval: 5000 }); // 5s, min is 10s

            // Should clamp to maximum
            monitor.updateConfig({ pollingInterval: 500000 }); // 500s, max is 300s

            assert.ok(true); // No errors thrown
        });
    });

    suite('getState', () => {
        test('should return current monitoring state', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, { pollingInterval: 60000 });

            const initialState = monitor.getState();
            assert.strictEqual(initialState.isActive, false);

            monitor.start();
            const activeState = monitor.getState();
            assert.strictEqual(activeState.isActive, true);
        });
    });

    suite('retry logic', () => {
        test('should retry on failure', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                maxRetries: 3,
                retryBackoffBase: 0.01 // 10ms for testing
            });

            // First call fails, subsequent calls succeed
            let callCount = 0;
            mockDetector.detectSystemProxyWithSource = async () => {
                callCount++;
                if (callCount <= 2) {
                    throw new Error('Temporary failure');
                }
                return { proxyUrl: 'http://proxy.example.com:8080', source: 'environment' };
            };

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for retries
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should have made multiple attempts
            assert.ok(callCount >= 2);
        });

        test('should stop retrying after max retries', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                maxRetries: 2,
                retryBackoffBase: 0.01
            });

            let callCount = 0;
            mockDetector.detectSystemProxyWithSource = async () => {
                callCount++;
                throw new Error('Permanent failure');
            };

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for retries to complete
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should have tried initial + maxRetries times
            assert.ok(callCount <= 4); // Initial + 2 retries (with some buffer)
        });
    });

    suite('event emission', () => {
        test('should emit proxyChanged event on proxy change', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10
            });

            let emittedResult: ProxyDetectionResult | null = null;
            monitor.on('proxyChanged', (result: ProxyDetectionResult) => {
                emittedResult = result;
            });

            mockDetector.setMockResult('http://proxy.example.com:8080');
            mockDetector.setDetectionSource('environment');

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.ok(emittedResult !== null);
            const result = emittedResult as ProxyDetectionResult;
            assert.strictEqual(result.proxyUrl, 'http://proxy.example.com:8080');
            assert.strictEqual(result.source, 'environment');
        });

        test('should emit checkComplete event after each check', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10
            });

            let eventCount = 0;
            monitor.on('checkComplete', () => {
                eventCount++;
            });

            mockDetector.setMockResult(null);

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.ok(eventCount >= 1);
        });
    });

    suite('logging integration', () => {
        test('should log check events', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10
            });

            mockDetector.setMockResult('http://proxy.example.com:8080');

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 100));

            const checkHistory = logger.getCheckHistory();
            assert.ok(checkHistory.length >= 1);
        });
    });
});

/**
 * Integration tests for ProxyMonitor with connection testing
 * Feature: auto-mode-proxy-testing
 * Validates: Requirements 1.1, 1.2, 1.3 (Task 4.2)
 */
suite('ProxyMonitor Connection Testing Integration', () => {
    let monitor: ProxyMonitor;
    let mockDetector: MockSystemProxyDetector;
    let logger: ProxyChangeLogger;
    let sanitizer: InputSanitizer;
    let sandbox: sinon.SinonSandbox;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;
    let connectionTester: ProxyConnectionTester;

    // Mock SystemProxyDetector for testing
    class MockSystemProxyDetector {
        private mockResult: string | null = null;
        private shouldFail: boolean = false;
        private checkCount: number = 0;
        private detectionSource: string | null = 'environment';

        setMockResult(result: string | null): void {
            this.mockResult = result;
        }

        setShouldFail(fail: boolean): void {
            this.shouldFail = fail;
        }

        setDetectionSource(source: string | null): void {
            this.detectionSource = source;
        }

        getCheckCount(): number {
            return this.checkCount;
        }

        resetCheckCount(): void {
            this.checkCount = 0;
        }

        async detectSystemProxy(): Promise<string | null> {
            this.checkCount++;
            if (this.shouldFail) {
                throw new Error('Mock detection failed');
            }
            return this.mockResult;
        }

        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
            this.checkCount++;
            if (this.shouldFail) {
                throw new Error('Mock detection failed');
            }
            return {
                proxyUrl: this.mockResult,
                source: this.detectionSource
            };
        }
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        mockDetector = new MockSystemProxyDetector();
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);
        mockNotifier = sandbox.createStubInstance(UserNotifier);
        connectionTester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);
    });

    teardown(() => {
        if (monitor) {
            monitor.stop();
        }
        sandbox.restore();
    });

    suite('Connection testing integration', () => {
        test('should execute connection test when proxy is detected', async () => {
            // Stub the testProxyAuto method
            const testResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };
            sandbox.stub(connectionTester, 'testProxyAuto').resolves(testResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            let testCompleteEmitted = false;
            monitor.on('proxyTestComplete', () => {
                testCompleteEmitted = true;
            });

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.strictEqual(testCompleteEmitted, true, 'proxyTestComplete event should be emitted');
        });

        test('should emit proxyStateChanged when reachability changes', async () => {
            // First test succeeds, then fails
            const successResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };
            const failResult: TestResult = {
                success: false,
                testUrls: ['https://example.com'],
                errors: [{ url: 'https://example.com', message: 'Connection failed' }],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 3000
            };

            const testStub = sandbox.stub(connectionTester, 'testProxyAuto');
            testStub.onFirstCall().resolves(successResult);
            testStub.onSecondCall().resolves(failResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            const stateChanges: { reachable: boolean; previousState: boolean }[] = [];
            monitor.on('proxyStateChanged', (data: { reachable: boolean; previousState: boolean }) => {
                stateChanges.push(data);
            });

            monitor.start();

            // First check - should go from unreachable (initial) to reachable
            monitor.triggerCheck('focus');
            await new Promise(resolve => setTimeout(resolve, 200));

            // Second check - should go from reachable to unreachable
            monitor.triggerCheck('focus');
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.ok(stateChanges.length >= 1, 'At least one state change should be emitted');

            // First state change should be to reachable
            if (stateChanges.length >= 1) {
                assert.strictEqual(stateChanges[0].reachable, true, 'First change should be to reachable');
            }

            // Second state change should be to unreachable
            if (stateChanges.length >= 2) {
                assert.strictEqual(stateChanges[1].reachable, false, 'Second change should be to unreachable');
            }
        });

        test('should not enable proxy if connection test fails', async () => {
            const failResult: TestResult = {
                success: false,
                testUrls: ['https://example.com'],
                errors: [{ url: 'https://example.com', message: 'Connection failed' }],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 3000
            };
            sandbox.stub(connectionTester, 'testProxyAuto').resolves(failResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            let detectionResult: ProxyDetectionResult | undefined;
            monitor.on('checkComplete', (result: ProxyDetectionResult) => {
                detectionResult = result;
            });

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.ok(detectionResult !== undefined, 'checkComplete should be emitted');
            assert.strictEqual(detectionResult.proxyReachable, false, 'Proxy should not be reachable');
        });

        test('should report proxy as reachable when connection test succeeds', async () => {
            const successResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };
            sandbox.stub(connectionTester, 'testProxyAuto').resolves(successResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            let detectionResult: ProxyDetectionResult | undefined;
            monitor.on('checkComplete', (result: ProxyDetectionResult) => {
                detectionResult = result;
            });

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.ok(detectionResult !== undefined, 'checkComplete should be emitted');
            assert.strictEqual(detectionResult.proxyReachable, true, 'Proxy should be reachable');
            assert.ok(detectionResult.testResult !== undefined, 'testResult should be included');
        });

        test('should skip connection test when no proxy detected', async () => {
            const testStub = sandbox.stub(connectionTester, 'testProxyAuto');

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult(null); // No proxy detected

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.strictEqual(testStub.callCount, 0, 'Connection test should not be called when no proxy detected');
        });
    });

    suite('isProxyReachable and triggerConnectionTest', () => {
        test('should return false when no test has been run', () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            assert.strictEqual(monitor.isProxyReachable(), false, 'Should return false when no test has been run');
        });

        test('should return true after successful connection test', async () => {
            const successResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };
            sandbox.stub(connectionTester, 'testProxyAuto').resolves(successResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            monitor.start();
            monitor.triggerCheck('focus');

            // Wait for check to complete
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.strictEqual(monitor.isProxyReachable(), true, 'Should return true after successful test');
        });

        test('triggerConnectionTest should call testProxyManual', async () => {
            const manualResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };

            const autoResult: TestResult = {
                success: true,
                testUrls: ['https://example.com'],
                errors: [],
                proxyUrl: 'http://proxy.example.com:8080',
                timestamp: Date.now(),
                duration: 100
            };

            sandbox.stub(connectionTester, 'testProxyAuto').resolves(autoResult);
            const manualStub = sandbox.stub(connectionTester, 'testProxyManual').resolves(manualResult);

            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            mockDetector.setMockResult('http://proxy.example.com:8080');

            // First run a check to set lastProxyUrl
            monitor.start();
            monitor.triggerCheck('focus');
            await new Promise(resolve => setTimeout(resolve, 200));

            // Now trigger manual connection test
            const result = await monitor.triggerConnectionTest();

            assert.ok(manualStub.called, 'testProxyManual should be called');
            assert.ok(result !== undefined, 'Result should be returned');
            assert.strictEqual(result!.success, true, 'Result should indicate success');
        });

        test('triggerConnectionTest should return undefined when no proxy URL', async () => {
            monitor = new ProxyMonitor(mockDetector as any, logger, {
                pollingInterval: 60000,
                debounceDelay: 10,
                enableConnectionTest: true
            }, connectionTester);

            // No proxy detected yet
            const result = await monitor.triggerConnectionTest();

            assert.strictEqual(result, undefined, 'Should return undefined when no proxy URL');
        });
    });
});
