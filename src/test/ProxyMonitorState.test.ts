/**
 * Unit tests for ProxyMonitorState
 * Tests state management for proxy monitoring
 */

import * as assert from 'assert';
import { ProxyMonitorState, MonitoringStatus } from '../monitoring/ProxyMonitorState';

suite('ProxyMonitorState Test Suite', () => {
    let state: ProxyMonitorState;

    setup(() => {
        state = new ProxyMonitorState();
    });

    suite('constructor', () => {
        test('should initialize with default inactive state', () => {
            const status = state.getStatus();

            assert.strictEqual(status.isActive, false);
            assert.strictEqual(status.lastCheckTime, null);
            assert.strictEqual(status.lastSuccessTime, null);
            assert.strictEqual(status.lastFailureTime, null);
            assert.strictEqual(status.consecutiveFailures, 0);
            assert.strictEqual(status.currentProxy, null);
            assert.strictEqual(status.detectionSource, null);
        });
    });

    suite('setActive', () => {
        test('should set isActive to true when called with true', () => {
            state.setActive(true);
            assert.strictEqual(state.getStatus().isActive, true);
        });

        test('should set isActive to false when called with false', () => {
            state.setActive(true);
            state.setActive(false);
            assert.strictEqual(state.getStatus().isActive, false);
        });
    });

    suite('recordCheckStart', () => {
        test('should update lastCheckTime', () => {
            const beforeTime = Date.now();
            state.recordCheckStart();
            const afterTime = Date.now();

            const status = state.getStatus();
            assert.ok(status.lastCheckTime !== null);
            assert.ok(status.lastCheckTime >= beforeTime);
            assert.ok(status.lastCheckTime <= afterTime);
        });
    });

    suite('recordCheckSuccess', () => {
        test('should update lastSuccessTime and reset consecutiveFailures', () => {
            // First record some failures
            state.recordCheckFailure();
            state.recordCheckFailure();
            assert.strictEqual(state.getStatus().consecutiveFailures, 2);

            const beforeTime = Date.now();
            state.recordCheckSuccess('http://proxy.example.com:8080', 'environment');
            const afterTime = Date.now();

            const status = state.getStatus();
            assert.ok(status.lastSuccessTime !== null);
            assert.ok(status.lastSuccessTime >= beforeTime);
            assert.ok(status.lastSuccessTime <= afterTime);
            assert.strictEqual(status.consecutiveFailures, 0);
            assert.strictEqual(status.currentProxy, 'http://proxy.example.com:8080');
            assert.strictEqual(status.detectionSource, 'environment');
        });

        test('should handle null proxy URL', () => {
            state.recordCheckSuccess(null, null);

            const status = state.getStatus();
            assert.strictEqual(status.currentProxy, null);
            assert.strictEqual(status.detectionSource, null);
        });
    });

    suite('recordCheckFailure', () => {
        test('should increment consecutiveFailures', () => {
            state.recordCheckFailure();
            assert.strictEqual(state.getStatus().consecutiveFailures, 1);

            state.recordCheckFailure();
            assert.strictEqual(state.getStatus().consecutiveFailures, 2);

            state.recordCheckFailure();
            assert.strictEqual(state.getStatus().consecutiveFailures, 3);
        });

        test('should update lastFailureTime', () => {
            const beforeTime = Date.now();
            state.recordCheckFailure();
            const afterTime = Date.now();

            const status = state.getStatus();
            assert.ok(status.lastFailureTime !== null);
            assert.ok(status.lastFailureTime >= beforeTime);
            assert.ok(status.lastFailureTime <= afterTime);
        });
    });

    suite('resetFailureCount', () => {
        test('should reset consecutiveFailures to 0', () => {
            state.recordCheckFailure();
            state.recordCheckFailure();
            state.recordCheckFailure();
            assert.strictEqual(state.getStatus().consecutiveFailures, 3);

            state.resetFailureCount();
            assert.strictEqual(state.getStatus().consecutiveFailures, 0);
        });
    });

    suite('getStatus', () => {
        test('should return a copy of the status (immutable)', () => {
            state.recordCheckSuccess('http://proxy.example.com:8080', 'environment');

            const status1 = state.getStatus();
            const status2 = state.getStatus();

            // Should be different object references
            assert.notStrictEqual(status1, status2);

            // But same values
            assert.strictEqual(status1.currentProxy, status2.currentProxy);
            assert.strictEqual(status1.detectionSource, status2.detectionSource);
        });
    });

    suite('state persistence', () => {
        test('should maintain state across multiple operations', () => {
            state.setActive(true);
            state.recordCheckStart();
            state.recordCheckSuccess('http://proxy1.example.com:8080', 'vscode');
            state.recordCheckFailure();
            state.recordCheckFailure();
            state.recordCheckSuccess('http://proxy2.example.com:8080', 'environment');

            const status = state.getStatus();
            assert.strictEqual(status.isActive, true);
            assert.strictEqual(status.currentProxy, 'http://proxy2.example.com:8080');
            assert.strictEqual(status.detectionSource, 'environment');
            assert.strictEqual(status.consecutiveFailures, 0);
        });
    });
});
