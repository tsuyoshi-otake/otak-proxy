/**
 * Unit tests for ConflictResolver
 * Feature: multi-instance-sync
 * Requirements: 4.1, 4.2, 4.3, 4.4
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import { ConflictResolver, SyncableState, ConflictResolution } from '../../sync/ConflictResolver';
import { ProxyMode, ProxyState } from '../../core/types';

suite('ConflictResolver Unit Tests', () => {
    let resolver: ConflictResolver;

    setup(() => {
        resolver = new ConflictResolver();
    });

    /**
     * Requirement 4.1: Timestamp-based conflict resolution
     * When multiple instances change settings simultaneously,
     * the latest change (by timestamp) should win.
     */
    suite('Timestamp-based Resolution (Requirement 4.1)', () => {
        test('should resolve to remote when remote timestamp is newer', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual, manualProxyUrl: 'http://local:8080' },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto, autoProxyUrl: 'http://remote:8080' },
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'remote');
            assert.deepStrictEqual(result.resolvedState, remote);
        });

        test('should resolve to local when local timestamp is newer', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual, manualProxyUrl: 'http://local:8080' },
                timestamp: 3000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto, autoProxyUrl: 'http://remote:8080' },
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'local');
            assert.deepStrictEqual(result.resolvedState, local);
        });

        test('should resolve to remote when timestamps are equal (Requirement 4.4)', () => {
            // When timestamps are equal, remote wins (deterministic rule)
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual, manualProxyUrl: 'http://local:8080' },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto, autoProxyUrl: 'http://remote:8080' },
                timestamp: 1000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'remote');
            assert.deepStrictEqual(result.resolvedState, remote);
        });
    });

    /**
     * Requirement 4.2: Conflict notification
     * When conflict is detected, details should be provided
     */
    suite('Conflict Detection and Details (Requirement 4.2, 4.3)', () => {
        test('should return null conflictDetails for normal updates (remote newer)', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.conflictDetails, null);
        });

        test('should provide conflict details for out-of-order writes (local newer but remote observed)', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 2000,
                instanceId: 'instance-1',
                version: 2
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 1000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'local');
            assert.ok(result.conflictDetails);
            assert.strictEqual(result.conflictDetails!.localTimestamp, 2000);
            assert.strictEqual(result.conflictDetails!.remoteTimestamp, 1000);
            assert.strictEqual(result.conflictDetails!.localInstanceId, 'instance-1');
            assert.strictEqual(result.conflictDetails!.remoteInstanceId, 'instance-2');
            assert.strictEqual(result.conflictDetails!.conflictType, 'stale');
        });

        test('should mark conflict type as simultaneous when timestamps are equal', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 1000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.ok(result.conflictDetails);
            assert.strictEqual(result.conflictDetails!.conflictType, 'simultaneous');
        });

        test('should return null conflictDetails when no real conflict (same instance)', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 2000,
                instanceId: 'instance-1', // Same instance
                version: 2
            };

            const result = resolver.resolve(local, remote);

            // When same instance, it's not really a conflict, just an update
            assert.strictEqual(result.conflictDetails, null);
        });
    });

    /**
     * Requirement 4.4: User intent priority
     * The most recent user change should be prioritized
     */
    suite('User Intent Priority (Requirement 4.4)', () => {
        test('should prioritize the most recent change regardless of version', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 3000,
                instanceId: 'instance-1',
                version: 1 // Lower version but newer timestamp
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 5 // Higher version but older timestamp
            };

            const result = resolver.resolve(local, remote);

            // Timestamp should win over version
            assert.strictEqual(result.winner, 'local');
        });
    });

    /**
     * Edge cases and validation
     */
    suite('Edge Cases and Validation', () => {
        test('should reject future timestamps (beyond reasonable drift)', () => {
            const now = Date.now();
            const futureTimestamp = now + 60000; // 1 minute in the future

            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: now,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: futureTimestamp,
                instanceId: 'instance-2',
                version: 1
            };

            // Future timestamps should be rejected - local should win
            const result = resolver.resolve(local, remote);
            assert.strictEqual(result.winner, 'local');
        });

        test('should handle ProxyMode.Off state correctly', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Off },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Off },
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'remote');
            assert.strictEqual(result.resolvedState.state.mode, ProxyMode.Off);
        });

        test('should handle complex proxy state with all fields', () => {
            const localState: ProxyState = {
                mode: ProxyMode.Manual,
                manualProxyUrl: 'http://local:8080',
                autoProxyUrl: 'http://auto:8080',
                gitConfigured: true,
                vscodeConfigured: true,
                npmConfigured: false,
                systemProxyDetected: true,
                lastTestResult: {
                    success: true,
                    testUrls: ['https://example.com'],
                    errors: []
                },
                proxyReachable: true
            };

            const remoteState: ProxyState = {
                mode: ProxyMode.Auto,
                manualProxyUrl: 'http://remote:8080',
                autoProxyUrl: 'http://auto-remote:8080',
                gitConfigured: false,
                vscodeConfigured: false,
                npmConfigured: true,
                systemProxyDetected: false
            };

            const local: SyncableState = {
                state: localState,
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: remoteState,
                timestamp: 2000,
                instanceId: 'instance-2',
                version: 1
            };

            const result = resolver.resolve(local, remote);

            assert.strictEqual(result.winner, 'remote');
            assert.deepStrictEqual(result.resolvedState.state, remoteState);
        });
    });

    /**
     * Deterministic behavior
     */
    suite('Deterministic Behavior', () => {
        test('should always produce same result for same inputs', () => {
            const local: SyncableState = {
                state: { mode: ProxyMode.Manual },
                timestamp: 1000,
                instanceId: 'instance-1',
                version: 1
            };

            const remote: SyncableState = {
                state: { mode: ProxyMode.Auto },
                timestamp: 1000,
                instanceId: 'instance-2',
                version: 1
            };

            // Run multiple times
            const results: ConflictResolution[] = [];
            for (let i = 0; i < 10; i++) {
                results.push(resolver.resolve(local, remote));
            }

            // All results should be identical
            for (const result of results) {
                assert.strictEqual(result.winner, results[0].winner);
                assert.deepStrictEqual(result.resolvedState, results[0].resolvedState);
            }
        });
    });
});
