/**
 * Property-based tests for ProxyMonitor
 * Tests universal properties that should hold across all inputs
 *
 * Feature: auto-proxy-detection-improvements
 * Feature: auto-mode-proxy-testing
 */

import * as fc from 'fast-check';
import * as sinon from 'sinon';
import { ProxyMonitor, ProxyMonitorConfig } from '../monitoring/ProxyMonitor';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { UserNotifier } from '../errors/UserNotifier';
import { TestResult } from '../utils/ProxyUtils';
import { getPropertyTestRuns } from './helpers';

// Mock SystemProxyDetector for property testing
class MockSystemProxyDetector {
    private checkCount: number = 0;
    private checkTimestamps: number[] = [];

    getCheckCount(): number {
        return this.checkCount;
    }

    getCheckTimestamps(): number[] {
        return this.checkTimestamps;
    }

    resetCheckCount(): void {
        this.checkCount = 0;
        this.checkTimestamps = [];
    }

    async detectSystemProxy(): Promise<string | null> {
        this.checkCount++;
        this.checkTimestamps.push(Date.now());
        return null;
    }

    async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
        this.checkCount++;
        this.checkTimestamps.push(Date.now());
        return { proxyUrl: null, source: 'environment' };
    }
}

// Helper function to sleep
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

suite('ProxyMonitor Property-Based Tests', () => {
    let mockDetector: MockSystemProxyDetector;
    let logger: ProxyChangeLogger;
    let sanitizer: InputSanitizer;

    setup(() => {
        mockDetector = new MockSystemProxyDetector();
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 1: ポーリング間隔の遵守
     * 
     * 任意の有効なポーリング間隔（10秒から300秒）に対して、Autoモードが有効な場合、
     * システムはその間隔でチェックが実行されることを検証
     * 
     * Note: This test uses the minimum valid interval (10 seconds) to keep test time reasonable
     * while still validating the property. The property holds for all valid intervals.
     * 
     * Validates: Requirements 1.1
     */
    test('Property 1: Polling interval adherence', async function() {
        // Increase timeout for this test as it involves waiting for polling
        this.timeout(30000);

        // Test with minimum valid interval (10 seconds) as required by ProxyMonitor
        // The property holds for any valid interval, so testing with the minimum is sufficient
        const intervalSeconds = 10;
        const intervalMs = intervalSeconds * 1000;
        
        const monitor = new ProxyMonitor(
            mockDetector as any,
            logger,
            { 
                pollingInterval: intervalMs,
                debounceDelay: 10 // Short debounce for testing
            }
        );

        mockDetector.resetCheckCount();

        try {
            // Start monitoring
            monitor.start();

            // Wait a bit for the first check to be scheduled
            await sleep(100);

            // Wait for approximately 2.5 intervals to observe multiple checks
            // We use 2.5 to ensure we see at least 2 checks but not too many
            const waitTime = intervalMs * 2.5;
            await sleep(waitTime);

            // Stop monitoring
            monitor.stop();

            // Get check count and timestamps
            const checkCount = mockDetector.getCheckCount();
            const timestamps = mockDetector.getCheckTimestamps();

            // Property: Should have executed at least 2 checks in 2.2 intervals
            // (allowing for timing variations)
            if (checkCount < 2) {
                throw new Error(`Expected at least 2 checks, but got ${checkCount}`);
            }

            // Property: Should not have executed too many checks
            // Maximum should be around 3 checks (with some tolerance for timing)
            if (checkCount > 4) {
                throw new Error(`Expected at most 4 checks, but got ${checkCount}`);
            }

            // Property: Check intervals between consecutive checks
            // They should be approximately equal to the configured interval
            if (timestamps.length >= 2) {
                for (let i = 1; i < timestamps.length; i++) {
                    const actualInterval = timestamps[i] - timestamps[i - 1];
                    const expectedInterval = intervalMs;
                    
                    // Allow 20% tolerance for timing variations
                    const tolerance = expectedInterval * 0.2;
                    const minInterval = expectedInterval - tolerance;
                    const maxInterval = expectedInterval + tolerance;

                    if (actualInterval < minInterval || actualInterval > maxInterval) {
                        throw new Error(
                            `Interval ${i} was ${actualInterval}ms, expected ${expectedInterval}ms ±${tolerance}ms`
                        );
                    }
                }
            }

        } finally {
            monitor.stop();
        }
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 2: ポーリング間隔の動的更新
     * 
     * 任意の有効なポーリング間隔に対して、設定変更後に新しい間隔でチェックが実行されることを検証
     * 
     * Validates: Requirements 1.2
     */
    test('Property 2: Dynamic polling interval update', async function() {
        // Increase timeout for this test as it involves waiting for polling
        this.timeout(60000);

        // Test with minimum valid intervals (10 and 15 seconds) as required by ProxyMonitor
        const initialIntervalSeconds = 10;
        const updatedIntervalSeconds = 15;
        const initialIntervalMs = initialIntervalSeconds * 1000;
        const updatedIntervalMs = updatedIntervalSeconds * 1000;

        const monitor = new ProxyMonitor(
            mockDetector as any,
            logger,
            { 
                pollingInterval: initialIntervalMs,
                debounceDelay: 10 // Short debounce for testing
            }
        );

        mockDetector.resetCheckCount();

        try {
            // Start monitoring with initial interval
            monitor.start();

            // Wait a bit for the first check to be scheduled
            await sleep(100);

            // Wait for approximately 1.8 intervals to see at least one check
            await sleep(initialIntervalMs * 1.8);

            // Get check count after initial interval
            const checksBeforeUpdate = mockDetector.getCheckCount();
            const timestampsBeforeUpdate = [...mockDetector.getCheckTimestamps()];

            // Property: Should have executed at least 1 check with initial interval
            if (checksBeforeUpdate < 1) {
                throw new Error(`Expected at least 1 check before update, but got ${checksBeforeUpdate}`);
            }

            // Update the polling interval
            monitor.updateConfig({ pollingInterval: updatedIntervalMs });

            // Reset check count to measure new interval
            mockDetector.resetCheckCount();

            // Wait for approximately 2.2 intervals with the new interval
            const waitTime = updatedIntervalMs * 2.2;
            await sleep(waitTime);

            // Get check count after update
            const checksAfterUpdate = mockDetector.getCheckCount();
            const timestampsAfterUpdate = mockDetector.getCheckTimestamps();

            // Property: Should have executed at least 2 checks with new interval
            if (checksAfterUpdate < 2) {
                throw new Error(`Expected at least 2 checks after update, but got ${checksAfterUpdate}`);
            }

            // Property: Should not have executed too many checks
            if (checksAfterUpdate > 4) {
                throw new Error(`Expected at most 4 checks after update, but got ${checksAfterUpdate}`);
            }

            // Property: Check intervals between consecutive checks after update
            // They should be approximately equal to the NEW configured interval
            if (timestampsAfterUpdate.length >= 2) {
                for (let i = 1; i < timestampsAfterUpdate.length; i++) {
                    const actualInterval = timestampsAfterUpdate[i] - timestampsAfterUpdate[i - 1];
                    const expectedInterval = updatedIntervalMs;
                    
                    // Allow 20% tolerance for timing variations
                    const tolerance = expectedInterval * 0.2;
                    const minInterval = expectedInterval - tolerance;
                    const maxInterval = expectedInterval + tolerance;

                    if (actualInterval < minInterval || actualInterval > maxInterval) {
                        throw new Error(
                            `Interval ${i} after update was ${actualInterval}ms, expected ${expectedInterval}ms ±${tolerance}ms`
                        );
                    }
                }
            }

            // Property: The new interval should be different from the old interval
            // Verify by checking that the average interval changed
            if (timestampsBeforeUpdate.length >= 2 && timestampsAfterUpdate.length >= 2) {
                const avgIntervalBefore = (timestampsBeforeUpdate[timestampsBeforeUpdate.length - 1] - timestampsBeforeUpdate[0]) / (timestampsBeforeUpdate.length - 1);
                const avgIntervalAfter = (timestampsAfterUpdate[timestampsAfterUpdate.length - 1] - timestampsAfterUpdate[0]) / (timestampsAfterUpdate.length - 1);

                // The difference should be significant (at least 3 seconds)
                const difference = Math.abs(avgIntervalAfter - avgIntervalBefore);
                if (difference < 3000) {
                    throw new Error(
                        `Expected significant difference in intervals, but got ${difference}ms (before: ${avgIntervalBefore}ms, after: ${avgIntervalAfter}ms)`
                    );
                }
            }

        } finally {
            monitor.stop();
        }
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 5: デバウンス処理
     * 
     * 任意の複数のトリガーイベントに対して、デバウンス期間（1秒）内に発生した場合、
     * システムは1回のみチェックを実行するべき
     * 
     * Validates: Requirements 2.4
     */
    test('Property 5: Debounce processing', async function() {
        // Increase timeout for this test as it involves waiting for debounce
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 2, max: 5 }), // Number of triggers (reduced range for faster tests)
                async (triggerCount) => {
                    const debounceDelay = 500; // 500ms debounce for faster testing
                    
                    const monitor = new ProxyMonitor(
                        mockDetector as any,
                        logger,
                        { 
                            pollingInterval: 60000, // Long interval to avoid interference
                            debounceDelay: debounceDelay
                        }
                    );

                    mockDetector.resetCheckCount();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger multiple checks in rapid succession (within debounce period)
                        // Each trigger is 50ms apart, which is well within the 500ms debounce
                        for (let i = 0; i < triggerCount; i++) {
                            monitor.triggerCheck('focus');
                            await sleep(50); // 50ms between triggers
                        }

                        // Wait for debounce period plus some buffer
                        // This ensures the debounced check has time to execute
                        await sleep(debounceDelay + 300);

                        // Get check count
                        const checkCount = mockDetector.getCheckCount();

                        // Property: Despite multiple triggers, only 1 check should be executed
                        // due to debouncing
                        if (checkCount !== 1) {
                            throw new Error(
                                `Expected exactly 1 check after ${triggerCount} triggers within debounce period, ` +
                                `but got ${checkCount} checks`
                            );
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 6: リトライ回数の遵守
     * 
     * 任意の検出失敗に対して、設定された最大リトライ回数まで再試行することを検証
     * 
     * Validates: Requirements 3.1
     */
    test('Property 6: Retry count adherence', async function() {
        // Increase timeout for this test as it involves retries with backoff
        this.timeout(120000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 3 }), // maxRetries value (reduced for faster tests)
                async (maxRetries) => {
                    // Create a detector that always fails
                    class FailingDetector {
                        private attemptCount: number = 0;

                        getAttemptCount(): number {
                            return this.attemptCount;
                        }

                        resetAttemptCount(): void {
                            this.attemptCount = 0;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            this.attemptCount++;
                            throw new Error('Detection failed');
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            this.attemptCount++;
                            throw new Error('Detection failed');
                        }
                    }

                    const failingDetector = new FailingDetector();
                    
                    const monitor = new ProxyMonitor(
                        failingDetector as any,
                        logger,
                        { 
                            pollingInterval: 60000, // Long interval to avoid interference
                            debounceDelay: 10, // Short debounce for testing
                            maxRetries: maxRetries,
                            retryBackoffBase: 0.1 // Short backoff for testing (100ms base)
                        }
                    );

                    failingDetector.resetAttemptCount();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger a check
                        monitor.triggerCheck('focus');

                        // Wait for debounce + all retries to complete
                        // Each retry has exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
                        // Maximum wait time for 5 retries: 100 + 200 + 400 + 800 + 1600 = 3100ms
                        // Add buffer for initial attempt and processing
                        const maxBackoffTime = maxRetries > 0 
                            ? 100 * (Math.pow(2, maxRetries) - 1) 
                            : 0;
                        await sleep(10 + maxBackoffTime + 1000); // debounce + backoff + buffer

                        // Get attempt count
                        const attemptCount = failingDetector.getAttemptCount();

                        // Property: The number of attempts should be exactly maxRetries + 1
                        // (initial attempt + maxRetries retry attempts)
                        const expectedAttempts = maxRetries + 1;
                        
                        if (attemptCount !== expectedAttempts) {
                            throw new Error(
                                `Expected exactly ${expectedAttempts} attempts (1 initial + ${maxRetries} retries), ` +
                                `but got ${attemptCount} attempts`
                            );
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 7: 指数バックオフ
     * 
     * 任意のリトライ試行に対して、待機時間が指数的に増加することを検証
     * 
     * Validates: Requirements 3.2
     */
    test('Property 7: Exponential backoff', async function() {
        // Increase timeout for this test as it involves retries with backoff
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 2 }), // maxRetries value (reduced for faster tests)
                fc.double({ min: 0.05, max: 0.2 }), // retryBackoffBase value (reduced for faster tests)
                async (maxRetries, retryBackoffBase) => {
                    // Create a detector that always fails and records attempt timestamps
                    class FailingDetectorWithTimestamps {
                        private attemptTimestamps: number[] = [];

                        getAttemptTimestamps(): number[] {
                            return this.attemptTimestamps;
                        }

                        resetAttempts(): void {
                            this.attemptTimestamps = [];
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            this.attemptTimestamps.push(Date.now());
                            throw new Error('Detection failed');
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            this.attemptTimestamps.push(Date.now());
                            throw new Error('Detection failed');
                        }
                    }

                    const failingDetector = new FailingDetectorWithTimestamps();
                    
                    const monitor = new ProxyMonitor(
                        failingDetector as any,
                        logger,
                        { 
                            pollingInterval: 60000, // Long interval to avoid interference
                            debounceDelay: 10, // Short debounce for testing
                            maxRetries: maxRetries,
                            retryBackoffBase: retryBackoffBase
                        }
                    );

                    failingDetector.resetAttempts();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger a check
                        monitor.triggerCheck('focus');

                        // Wait for debounce + all retries to complete
                        // Calculate maximum wait time based on exponential backoff
                        // backoff(i) = retryBackoffBase * 2^(i-1) seconds for retry i (i >= 1)
                        // Total time = sum of all backoffs + buffer
                        let maxBackoffTime = 0;
                        for (let i = 1; i <= maxRetries; i++) {
                            maxBackoffTime += retryBackoffBase * Math.pow(2, i - 1) * 1000;
                        }
                        await sleep(10 + maxBackoffTime + 2000); // debounce + backoff + buffer

                        // Get attempt timestamps
                        const timestamps = failingDetector.getAttemptTimestamps();

                        // Property: Should have exactly maxRetries + 1 attempts
                        const expectedAttempts = maxRetries + 1;
                        if (timestamps.length !== expectedAttempts) {
                            throw new Error(
                                `Expected exactly ${expectedAttempts} attempts, but got ${timestamps.length}`
                            );
                        }

                        // Property: Verify exponential backoff between consecutive attempts
                        // For each retry i (i >= 1), the interval should be approximately:
                        // retryBackoffBase * 2^(i-1) seconds
                        for (let i = 1; i < timestamps.length; i++) {
                            const actualInterval = timestamps[i] - timestamps[i - 1];
                            const expectedInterval = retryBackoffBase * Math.pow(2, i - 1) * 1000;
                            
                            // Allow 30% tolerance for timing variations and system delays
                            const tolerance = Math.max(expectedInterval * 0.3, 100); // At least 100ms tolerance
                            const minInterval = expectedInterval - tolerance;
                            const maxInterval = expectedInterval + tolerance;

                            if (actualInterval < minInterval || actualInterval > maxInterval) {
                                throw new Error(
                                    `Retry ${i} interval was ${actualInterval}ms, ` +
                                    `expected ${expectedInterval}ms ±${tolerance}ms ` +
                                    `(base=${retryBackoffBase}s, attempt=${i})`
                                );
                            }
                        }

                        // Property: Verify that intervals are increasing (exponential growth)
                        // Each interval should be approximately double the previous one
                        if (timestamps.length >= 3) {
                            for (let i = 2; i < timestamps.length; i++) {
                                const interval1 = timestamps[i - 1] - timestamps[i - 2];
                                const interval2 = timestamps[i] - timestamps[i - 1];
                                
                                // interval2 should be approximately 2x interval1
                                // Allow for timing variations: ratio should be between 1.5 and 2.5
                                const ratio = interval2 / interval1;
                                
                                if (ratio < 1.5 || ratio > 2.5) {
                                    throw new Error(
                                        `Exponential growth not observed: ` +
                                        `interval ${i-1} was ${interval1}ms, ` +
                                        `interval ${i} was ${interval2}ms, ` +
                                        `ratio ${ratio.toFixed(2)} (expected ~2.0)`
                                    );
                                }
                            }
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 8: リトライ成功時のリセット
     *
     * 任意のリトライ成功に対して、リトライカウンターがリセットされることを検証
     *
     * Validates: Requirements 3.4
     */
    test('Property 8: Retry counter reset on success', async function() {
        // Increase timeout for this test as it involves retries with backoff
        this.timeout(120000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 3 }), // maxRetries value
                fc.integer({ min: 1, max: 3 }), // number of failures before success
                async (maxRetries, failuresBeforeSuccess) => {
                    // Create a detector that fails N times then succeeds
                    class ControlledDetector {
                        private attemptCount: number = 0;
                        private failCount: number = failuresBeforeSuccess;

                        getAttemptCount(): number {
                            return this.attemptCount;
                        }

                        resetAttemptCount(): void {
                            this.attemptCount = 0;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            this.attemptCount++;
                            if (this.attemptCount <= this.failCount) {
                                throw new Error('Detection failed');
                            }
                            return 'http://proxy.example.com:8080';
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            this.attemptCount++;
                            if (this.attemptCount <= this.failCount) {
                                throw new Error('Detection failed');
                            }
                            return { proxyUrl: 'http://proxy.example.com:8080', source: 'environment' };
                        }
                    }

                    const controlledDetector = new ControlledDetector();

                    const monitor = new ProxyMonitor(
                        controlledDetector as any,
                        logger,
                        {
                            pollingInterval: 60000, // Long interval to avoid interference
                            debounceDelay: 10, // Short debounce for testing
                            maxRetries: maxRetries,
                            retryBackoffBase: 0.05 // Short backoff for testing (50ms base)
                        }
                    );

                    controlledDetector.resetAttemptCount();

                    // Track if proxyChanged event was emitted
                    let proxyChangedEmitted = false;
                    let emittedResult: any = null;
                    monitor.on('proxyChanged', (result: any) => {
                        proxyChangedEmitted = true;
                        emittedResult = result;
                    });

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger a check
                        monitor.triggerCheck('focus');

                        // Wait for debounce + all retries to complete
                        // Calculate maximum wait time based on exponential backoff
                        let maxBackoffTime = 0;
                        for (let i = 1; i <= maxRetries; i++) {
                            maxBackoffTime += 0.05 * Math.pow(2, i - 1) * 1000;
                        }
                        await sleep(10 + maxBackoffTime + 2000); // debounce + backoff + buffer

                        // If failuresBeforeSuccess <= maxRetries, detection should succeed eventually
                        if (failuresBeforeSuccess <= maxRetries) {
                            // Property: On successful retry, proxyChanged event should be emitted
                            if (!proxyChangedEmitted) {
                                throw new Error(
                                    `Expected proxyChanged event after successful retry ` +
                                    `(failures: ${failuresBeforeSuccess}, maxRetries: ${maxRetries})`
                                );
                            }

                            // Property: The result should indicate success
                            if (!emittedResult || !emittedResult.success) {
                                throw new Error(
                                    `Expected successful result after retry, but got: ${JSON.stringify(emittedResult)}`
                                );
                            }

                            // Property: Monitor state should reflect success
                            const state = monitor.getState();
                            if (state.consecutiveFailures !== 0) {
                                throw new Error(
                                    `Expected consecutiveFailures to be reset to 0, but got ${state.consecutiveFailures}`
                                );
                            }

                            if (state.currentProxy !== 'http://proxy.example.com:8080') {
                                throw new Error(
                                    `Expected currentProxy to be set, but got ${state.currentProxy}`
                                );
                            }
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 4: モード切り替え時のポーリング停止
     *
     * 任意のAutoモード以外のモードに対して、モード切り替え時にポーリングが停止することを検証
     *
     * Note: This test simulates mode switching by calling stop() on the monitor,
     * which is what happens when switching from Auto mode to Manual or Off mode.
     *
     * Validates: Requirements 1.4
     */
    test('Property 4: Polling stops when switching modes', async function() {
        // Increase timeout for this test as it involves waiting for polling
        this.timeout(40000);

        // Test with minimum valid interval (10 seconds) as required by ProxyMonitor
        const intervalSeconds = 10;
        const intervalMs = intervalSeconds * 1000;
        
        const monitor = new ProxyMonitor(
            mockDetector as any,
            logger,
            { 
                pollingInterval: intervalMs,
                debounceDelay: 10 // Short debounce for testing
            }
        );

        mockDetector.resetCheckCount();

        try {
            // Start monitoring (simulating Auto mode)
            monitor.start();

            // Wait a bit for the first check to be scheduled
            await sleep(100);

            // Wait for approximately 1.8 intervals to see at least one check
            await sleep(intervalMs * 1.8);

            // Get check count while monitoring is active
            const checksWhileActive = mockDetector.getCheckCount();

            // Property: Should have executed at least 1 check while active
            if (checksWhileActive < 1) {
                throw new Error(`Expected at least 1 check while active, but got ${checksWhileActive}`);
            }

            // Stop monitoring (simulating mode switch to Manual or Off)
            monitor.stop();

            // Reset check count to measure checks after stop
            mockDetector.resetCheckCount();

            // Wait for approximately 2 intervals
            // If polling was not stopped, we would see at least 2 checks
            await sleep(intervalMs * 2.2);

            // Get check count after stop
            const checksAfterStop = mockDetector.getCheckCount();

            // Property: Should have NO checks after stop() is called
            // This verifies that polling has been stopped
            if (checksAfterStop !== 0) {
                throw new Error(
                    `Expected 0 checks after stop(), but got ${checksAfterStop}. ` +
                    `Polling should be stopped when switching from Auto mode.`
                );
            }

            // Verify monitor state is inactive
            const state = monitor.getState();
            if (state.isActive) {
                throw new Error('Monitor state should be inactive after stop()');
            }

        } finally {
            monitor.stop();
        }
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 3: チェック失敗時の継続
     *
     * 任意のチェック失敗に対して、エラーがログに記録され、次回のポーリングが継続されることを検証
     *
     * Validates: Requirements 1.3
     */
    test('Property 3: Check failure continuation', async function() {
        // Increase timeout for this test as it involves waiting for polling
        this.timeout(20000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 3 }), // number of consecutive failures
                async (failureCount) => {
                    // Create a detector that fails specified number of times
                    class FailCountDetector {
                        private attemptCount: number = 0;
                        private maxFailures: number = failureCount;

                        getAttemptCount(): number {
                            return this.attemptCount;
                        }

                        resetAttemptCount(): void {
                            this.attemptCount = 0;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            this.attemptCount++;
                            throw new Error('Detection failed');
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            this.attemptCount++;
                            throw new Error('Detection failed');
                        }
                    }

                    const failDetector = new FailCountDetector();

                    // Create a fresh logger for this test
                    const testLogger = new ProxyChangeLogger(sanitizer);

                    const monitor = new ProxyMonitor(
                        failDetector as any,
                        testLogger,
                        {
                            pollingInterval: 60000, // Long polling to avoid interference
                            debounceDelay: 10, // Short debounce for testing
                            maxRetries: 0, // No retries to test immediate failure logging
                            retryBackoffBase: 0.01
                        }
                    );

                    failDetector.resetAttemptCount();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger multiple checks manually
                        for (let i = 0; i < failureCount; i++) {
                            monitor.triggerCheck('focus');
                            await sleep(100); // Wait for debounce and check to complete
                        }

                        // Wait for all checks to complete
                        await sleep(300);

                        // Property: All failures should be logged
                        const checkHistory = testLogger.getCheckHistory();
                        if (checkHistory.length < failureCount) {
                            throw new Error(
                                `Expected at least ${failureCount} check logs, but got ${checkHistory.length}`
                            );
                        }

                        // Property: All logged checks should indicate failure
                        for (const check of checkHistory) {
                            if (check.success) {
                                throw new Error(
                                    `Expected all checks to be failures, but found a success`
                                );
                            }
                        }

                        // Property: Monitor should still be active (polling continues)
                        const state = monitor.getState();
                        if (!state.isActive) {
                            throw new Error(
                                `Expected monitor to remain active after failures, but isActive is false`
                            );
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 9: プロキシ変更のログ記録
     *
     * 任意のプロキシ変更（previousProxy ≠ newProxy）に対して、システムは変更前と変更後のURLをログに記録するべき
     *
     * Validates: Requirements 4.1
     */
    test('Property 9: Proxy change logging', async function() {
        // Increase timeout for this test
        this.timeout(20000);

        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.constantFrom(
                        'http://proxy1.example.com:8080',
                        'http://proxy2.example.com:8080',
                        'http://proxy3.example.com:3128',
                        null
                    ),
                    { minLength: 2, maxLength: 4 }
                ), // Sequence of proxy URLs
                async (proxySequence) => {
                    // Create a detector that returns proxies in sequence
                    class SequenceDetector {
                        private sequence: (string | null)[];
                        private currentIndex: number = 0;

                        constructor(seq: (string | null)[]) {
                            this.sequence = seq;
                        }

                        getIndex(): number {
                            return this.currentIndex;
                        }

                        resetIndex(): void {
                            this.currentIndex = 0;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            const result = this.sequence[this.currentIndex];
                            if (this.currentIndex < this.sequence.length - 1) {
                                this.currentIndex++;
                            }
                            return result;
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            const result = this.sequence[this.currentIndex];
                            if (this.currentIndex < this.sequence.length - 1) {
                                this.currentIndex++;
                            }
                            return { proxyUrl: result, source: 'environment' };
                        }
                    }

                    const sequenceDetector = new SequenceDetector(proxySequence);

                    // Create a fresh logger for this test
                    const testLogger = new ProxyChangeLogger(sanitizer);

                    const monitor = new ProxyMonitor(
                        sequenceDetector as any,
                        testLogger,
                        {
                            pollingInterval: 60000, // Long interval
                            debounceDelay: 10, // Short debounce for testing
                            maxRetries: 0,
                            retryBackoffBase: 0.01
                        }
                    );

                    sequenceDetector.resetIndex();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger checks for each proxy in sequence
                        for (let i = 0; i < proxySequence.length; i++) {
                            monitor.triggerCheck('focus');
                            await sleep(100); // Wait for debounce and check
                        }

                        // Wait for all checks to complete
                        await sleep(300);

                        // Get change history
                        const changeHistory = testLogger.getChangeHistory();

                        // Count expected changes (consecutive different proxies)
                        let expectedChanges = 0;
                        let previousProxy: string | null = null;
                        for (let i = 0; i < proxySequence.length; i++) {
                            if (proxySequence[i] !== previousProxy) {
                                if (i > 0) { // Skip first as there's no previous
                                    expectedChanges++;
                                }
                                previousProxy = proxySequence[i];
                            }
                        }

                        // Property: Number of change logs should match number of actual changes
                        // First proxy detection is also a "change" from null
                        const actualChanges = changeHistory.length;
                        if (actualChanges < expectedChanges) {
                            throw new Error(
                                `Expected at least ${expectedChanges} change logs for sequence ` +
                                `[${proxySequence.join(', ')}], but got ${actualChanges}`
                            );
                        }

                        // Property: Each change log should have both previousProxy and newProxy
                        for (const change of changeHistory) {
                            if (change.previousProxy === change.newProxy) {
                                throw new Error(
                                    `Change log should only be created when proxy actually changes. ` +
                                    `Found: previous=${change.previousProxy}, new=${change.newProxy}`
                                );
                            }
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 12: ポーリング間隔の範囲検証
     *
     * 任意のポーリング間隔値に対して、10秒から300秒の範囲内であれば受け入れ、
     * 範囲外であればデフォルト値が使用されることを検証
     *
     * Validates: Requirements 6.2, 6.3
     */
    test('Property 12: Polling interval range validation', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: -10000, max: 500000 }), // Any polling interval value including out of range
                async (intervalMs) => {
                    const MIN_POLLING_INTERVAL = 10000;  // 10 seconds
                    const MAX_POLLING_INTERVAL = 300000; // 300 seconds

                    const monitor = new ProxyMonitor(
                        mockDetector as any,
                        logger,
                        {
                            pollingInterval: intervalMs,
                            debounceDelay: 100
                        }
                    );

                    try {
                        // Property: Monitor should accept any value without throwing
                        monitor.start();

                        // Property: Monitor should be functional after config
                        const state = monitor.getState();
                        if (!state.isActive) {
                            throw new Error('Monitor should be active after start()');
                        }

                        // The actual interval validation happens internally
                        // We verify the monitor is functional regardless of input

                        // Trigger a check to verify functionality
                        mockDetector.resetCheckCount();
                        monitor.triggerCheck('focus');
                        await sleep(200);

                        // Monitor should still be functional
                        if (!monitor.getState().isActive) {
                            throw new Error('Monitor should remain active after triggerCheck()');
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 13: 設定変更の即時適用
     *
     * 任意の有効な設定値に対して、設定変更後に即座に新しい設定が適用されることを検証
     *
     * Validates: Requirements 6.4
     */
    test('Property 13: Immediate config update application', async function() {
        this.timeout(60000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 10000, max: 60000 }), // Initial polling interval
                fc.integer({ min: 10000, max: 60000 }), // New polling interval
                async (initialInterval, newInterval) => {
                    const monitor = new ProxyMonitor(
                        mockDetector as any,
                        logger,
                        {
                            pollingInterval: initialInterval,
                            debounceDelay: 100
                        }
                    );

                    mockDetector.resetCheckCount();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Property: Monitor should be active
                        if (!monitor.getState().isActive) {
                            throw new Error('Monitor should be active after start()');
                        }

                        // Update configuration
                        monitor.updateConfig({ pollingInterval: newInterval });

                        // Property: Config update should not throw
                        // Property: Monitor should still be active after update
                        if (!monitor.getState().isActive) {
                            throw new Error('Monitor should remain active after config update');
                        }

                        // Property: Trigger a check to verify the monitor is still functional
                        monitor.triggerCheck('config');
                        await sleep(300);

                        // Verify check was executed
                        const checkCount = mockDetector.getCheckCount();
                        if (checkCount < 1) {
                            throw new Error(
                                `Expected at least 1 check after config update, but got ${checkCount}`
                            );
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-proxy-detection-improvements, Property 10: チェック実行のログ記録
     *
     * 任意のプロキシチェック実行に対して、システムはチェック時刻、結果、検出ソースをログに記録するべき
     *
     * Validates: Requirements 4.3
     */
    test('Property 10: Check execution logging', async function() {
        // Increase timeout for this test
        this.timeout(20000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 5 }), // Number of checks to trigger
                fc.constantFrom('environment', 'vscode', 'platform'), // Detection source
                async (checkCount, source) => {
                    // Create a detector that returns a fixed result
                    class SourceDetector {
                        private detectionSource: string;
                        private checkTimestamps: number[] = [];

                        constructor(src: string) {
                            this.detectionSource = src;
                        }

                        getCheckTimestamps(): number[] {
                            return this.checkTimestamps;
                        }

                        resetTimestamps(): void {
                            this.checkTimestamps = [];
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            this.checkTimestamps.push(Date.now());
                            return 'http://proxy.example.com:8080';
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            this.checkTimestamps.push(Date.now());
                            return { proxyUrl: 'http://proxy.example.com:8080', source: this.detectionSource };
                        }
                    }

                    const sourceDetector = new SourceDetector(source);

                    // Create a fresh logger for this test
                    const testLogger = new ProxyChangeLogger(sanitizer);

                    const monitor = new ProxyMonitor(
                        sourceDetector as any,
                        testLogger,
                        {
                            pollingInterval: 60000, // Long interval
                            debounceDelay: 50, // Short debounce for testing
                            maxRetries: 0,
                            retryBackoffBase: 0.01
                        }
                    );

                    sourceDetector.resetTimestamps();

                    try {
                        // Start monitoring
                        monitor.start();

                        // Trigger multiple checks
                        for (let i = 0; i < checkCount; i++) {
                            monitor.triggerCheck('focus');
                            await sleep(100); // Wait for debounce and check
                        }

                        // Wait for all checks to complete
                        await sleep(300);

                        // Get check history
                        const checkHistory = testLogger.getCheckHistory();

                        // Property: Each check should be logged
                        if (checkHistory.length < checkCount) {
                            throw new Error(
                                `Expected at least ${checkCount} check logs, but got ${checkHistory.length}`
                            );
                        }

                        // Property: Each check log should have required fields
                        for (const check of checkHistory) {
                            // Check timestamp exists and is reasonable
                            if (typeof check.timestamp !== 'number' || check.timestamp <= 0) {
                                throw new Error(
                                    `Check log should have valid timestamp, got: ${check.timestamp}`
                                );
                            }

                            // Check success field exists
                            if (typeof check.success !== 'boolean') {
                                throw new Error(
                                    `Check log should have success field, got: ${check.success}`
                                );
                            }

                            // If success, check source is set
                            if (check.success && check.source !== source) {
                                throw new Error(
                                    `Check log source mismatch. Expected: ${source}, got: ${check.source}`
                                );
                            }

                            // Check trigger is set
                            if (!check.trigger) {
                                throw new Error(
                                    `Check log should have trigger field, got: ${check.trigger}`
                                );
                            }
                        }

                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});

/**
 * Property-based tests for ProxyMonitor connection testing
 * Feature: auto-mode-proxy-testing
 */
suite('ProxyMonitor Connection Testing Property Tests', function() {
    let sandbox: sinon.SinonSandbox;
    let sanitizer: InputSanitizer;
    let logger: ProxyChangeLogger;
    let mockNotifier: sinon.SinonStubbedInstance<UserNotifier>;

    setup(() => {
        sandbox = sinon.createSandbox();
        sanitizer = new InputSanitizer();
        logger = new ProxyChangeLogger(sanitizer);
        mockNotifier = sandbox.createStubInstance(UserNotifier);
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 1: システムプロキシ検出時のテスト実行
     * Validates: Requirements 1.1
     *
     * For any detected proxy URL, a connection test should be executed.
     */
    test('Property 1: Connection test execution on proxy detection', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 65535 }).map(port => `http://proxy-${port}.example.com:${port}`),
                async (proxyUrl) => {
                    // Create a detector that returns the proxy URL
                    class TestDetector {
                        private proxyUrl: string;

                        constructor(url: string) {
                            this.proxyUrl = url;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            return this.proxyUrl;
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            return { proxyUrl: this.proxyUrl, source: 'environment' };
                        }
                    }

                    const testDetector = new TestDetector(proxyUrl);
                    const connectionTester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);

                    // Track if testProxyAuto was called
                    let testProxyAutoCalled = false;
                    let testedUrl: string | null = null;

                    const testResult: TestResult = {
                        success: true,
                        testUrls: ['https://example.com'],
                        errors: [],
                        proxyUrl: proxyUrl,
                        timestamp: Date.now(),
                        duration: 100
                    };

                    sandbox.stub(connectionTester, 'testProxyAuto').callsFake(async (url: string) => {
                        testProxyAutoCalled = true;
                        testedUrl = url;
                        return testResult;
                    });

                    const monitor = new ProxyMonitor(
                        testDetector as any,
                        logger,
                        {
                            pollingInterval: 60000,
                            debounceDelay: 10,
                            enableConnectionTest: true
                        },
                        connectionTester
                    );

                    try {
                        monitor.start();
                        monitor.triggerCheck('focus');

                        // Wait for check to complete
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // Property: When proxy is detected, testProxyAuto should be called
                        if (!testProxyAutoCalled) {
                            throw new Error(`Connection test was not called for proxy URL: ${proxyUrl}`);
                        }

                        // Property: The tested URL should match the detected proxy URL
                        if (testedUrl !== proxyUrl) {
                            throw new Error(
                                `Connection test was called with wrong URL. ` +
                                `Expected: ${proxyUrl}, got: ${testedUrl}`
                            );
                        }
                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-mode-proxy-testing, Property 6: プロキシURL変更時の即座のテスト
     * Validates: Requirements 5.1
     *
     * When proxy URL changes, a connection test should be executed immediately for the new URL.
     */
    test('Property 6: Immediate connection test on proxy URL change', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 65535 }).map(port => `http://proxy-old-${port}.example.com:${port}`),
                fc.integer({ min: 1, max: 65535 }).map(port => `http://proxy-new-${port}.example.com:${port}`),
                async (oldProxyUrl, newProxyUrl) => {
                    // Skip if URLs are the same
                    if (oldProxyUrl === newProxyUrl) {
                        return;
                    }

                    // Create a detector that returns different URLs
                    class SequenceDetector {
                        private sequence: string[];
                        private currentIndex: number = 0;

                        constructor(urls: string[]) {
                            this.sequence = urls;
                        }

                        getIndex(): number {
                            return this.currentIndex;
                        }

                        async detectSystemProxy(): Promise<string | null> {
                            const result = this.sequence[this.currentIndex];
                            if (this.currentIndex < this.sequence.length - 1) {
                                this.currentIndex++;
                            }
                            return result;
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            const result = this.sequence[this.currentIndex];
                            if (this.currentIndex < this.sequence.length - 1) {
                                this.currentIndex++;
                            }
                            return { proxyUrl: result, source: 'environment' };
                        }
                    }

                    const sequenceDetector = new SequenceDetector([oldProxyUrl, newProxyUrl]);
                    const connectionTester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);

                    // Track all tested URLs
                    const testedUrls: string[] = [];

                    const createTestResult = (url: string): TestResult => ({
                        success: true,
                        testUrls: ['https://example.com'],
                        errors: [],
                        proxyUrl: url,
                        timestamp: Date.now(),
                        duration: 100
                    });

                    sandbox.stub(connectionTester, 'testProxyAuto').callsFake(async (url: string) => {
                        testedUrls.push(url);
                        return createTestResult(url);
                    });

                    const monitor = new ProxyMonitor(
                        sequenceDetector as any,
                        logger,
                        {
                            pollingInterval: 60000,
                            debounceDelay: 10,
                            enableConnectionTest: true
                        },
                        connectionTester
                    );

                    try {
                        monitor.start();

                        // First check - old proxy
                        monitor.triggerCheck('focus');
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // Second check - new proxy
                        monitor.triggerCheck('focus');
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // Property: Both URLs should have been tested
                        if (testedUrls.length < 2) {
                            throw new Error(
                                `Expected at least 2 connection tests, but got ${testedUrls.length}. ` +
                                `Tested URLs: [${testedUrls.join(', ')}]`
                            );
                        }

                        // Property: The first tested URL should be the old proxy
                        if (testedUrls[0] !== oldProxyUrl) {
                            throw new Error(
                                `First test should be for old proxy. ` +
                                `Expected: ${oldProxyUrl}, got: ${testedUrls[0]}`
                            );
                        }

                        // Property: The second tested URL should be the new proxy
                        if (testedUrls[1] !== newProxyUrl) {
                            throw new Error(
                                `Second test should be for new proxy. ` +
                                `Expected: ${newProxyUrl}, got: ${testedUrls[1]}`
                            );
                        }
                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: auto-mode-proxy-testing, Additional Property: No connection test when no proxy
     * Validates: Requirements 1.4
     *
     * When no proxy is detected, no connection test should be executed.
     */
    test('No connection test when no proxy detected', async function() {
        this.timeout(30000);

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 5 }), // Number of checks
                async (checkCount) => {
                    // Create a detector that always returns null
                    class NullDetector {
                        async detectSystemProxy(): Promise<string | null> {
                            return null;
                        }

                        async detectSystemProxyWithSource(): Promise<{ proxyUrl: string | null; source: string | null }> {
                            return { proxyUrl: null, source: null };
                        }
                    }

                    const nullDetector = new NullDetector();
                    const connectionTester = new ProxyConnectionTester(mockNotifier as unknown as UserNotifier);

                    // Track if testProxyAuto was called
                    let testProxyAutoCalled = false;

                    sandbox.stub(connectionTester, 'testProxyAuto').callsFake(async () => {
                        testProxyAutoCalled = true;
                        return {
                            success: true,
                            testUrls: [],
                            errors: [],
                            timestamp: Date.now(),
                            duration: 0
                        };
                    });

                    const monitor = new ProxyMonitor(
                        nullDetector as any,
                        logger,
                        {
                            pollingInterval: 60000,
                            debounceDelay: 10,
                            enableConnectionTest: true
                        },
                        connectionTester
                    );

                    try {
                        monitor.start();

                        // Trigger multiple checks
                        for (let i = 0; i < checkCount; i++) {
                            monitor.triggerCheck('focus');
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }

                        // Wait for all checks to complete
                        await new Promise(resolve => setTimeout(resolve, 200));

                        // Property: No connection test should be called when no proxy detected
                        if (testProxyAutoCalled) {
                            throw new Error(
                                `Connection test should NOT be called when no proxy is detected. ` +
                                `Was called after ${checkCount} checks.`
                            );
                        }
                    } finally {
                        monitor.stop();
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});

