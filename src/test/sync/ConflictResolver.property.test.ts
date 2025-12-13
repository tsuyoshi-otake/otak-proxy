/**
 * Property-based tests for ConflictResolver
 * Feature: multi-instance-sync
 * Requirements: 4.1 - Ensures conflict resolution is deterministic
 *
 * Uses fast-check for property-based testing
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ConflictResolver, SyncableState } from '../../sync/ConflictResolver';
import { ProxyMode, ProxyState } from '../../core/types';

suite('ConflictResolver Property-Based Tests', () => {
    let resolver: ConflictResolver;

    setup(() => {
        resolver = new ConflictResolver();
    });

    /**
     * Arbitrary generators for property-based testing
     */
    const proxyModeArb = fc.constantFrom(ProxyMode.Off, ProxyMode.Manual, ProxyMode.Auto);

    const proxyStateArb: fc.Arbitrary<ProxyState> = fc.record({
        mode: proxyModeArb,
        manualProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
        autoProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
        gitConfigured: fc.option(fc.boolean(), { nil: undefined }),
        vscodeConfigured: fc.option(fc.boolean(), { nil: undefined }),
        npmConfigured: fc.option(fc.boolean(), { nil: undefined }),
        systemProxyDetected: fc.option(fc.boolean(), { nil: undefined })
    });

    const syncableStateArb: fc.Arbitrary<SyncableState> = fc.record({
        state: proxyStateArb,
        timestamp: fc.integer({ min: 0, max: Date.now() + 30000 }),
        instanceId: fc.uuid(),
        version: fc.integer({ min: 1, max: 1000 })
    });

    /**
     * Property: Resolution is always deterministic
     * Same inputs always produce the same output
     */
    test('resolution is deterministic - same inputs produce same output', () => {
        fc.assert(
            fc.property(syncableStateArb, syncableStateArb, (local, remote) => {
                const result1 = resolver.resolve(local, remote);
                const result2 = resolver.resolve(local, remote);

                assert.strictEqual(result1.winner, result2.winner);
                assert.deepStrictEqual(result1.resolvedState, result2.resolvedState);
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Resolution always produces a winner
     * For any two states, one will always be chosen as the winner
     */
    test('resolution always produces a winner', () => {
        fc.assert(
            fc.property(syncableStateArb, syncableStateArb, (local, remote) => {
                const result = resolver.resolve(local, remote);

                assert.ok(
                    result.winner === 'local' || result.winner === 'remote',
                    'Winner must be either local or remote'
                );

                assert.ok(
                    result.resolvedState !== undefined,
                    'Resolved state must be defined'
                );
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Newer timestamp wins (when both are valid)
     */
    test('newer timestamp always wins when both timestamps are valid', () => {
        fc.assert(
            fc.property(
                proxyStateArb,
                proxyStateArb,
                fc.integer({ min: 0, max: 1000000000000 }), // Base timestamp
                fc.integer({ min: 1, max: 100000 }), // Offset
                (state1, state2, baseTimestamp, offset) => {
                    const olderTimestamp = baseTimestamp;
                    const newerTimestamp = baseTimestamp + offset;

                    const local: SyncableState = {
                        state: state1,
                        timestamp: olderTimestamp,
                        instanceId: 'instance-local',
                        version: 1
                    };

                    const remote: SyncableState = {
                        state: state2,
                        timestamp: newerTimestamp,
                        instanceId: 'instance-remote',
                        version: 1
                    };

                    const result = resolver.resolve(local, remote);
                    assert.strictEqual(result.winner, 'remote', 'Newer timestamp should win');
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Equal timestamps result in remote winning
     */
    test('equal timestamps always result in remote winning', () => {
        fc.assert(
            fc.property(
                proxyStateArb,
                proxyStateArb,
                fc.integer({ min: 0, max: 1000000000000 }),
                (state1, state2, timestamp) => {
                    const local: SyncableState = {
                        state: state1,
                        timestamp: timestamp,
                        instanceId: 'instance-local',
                        version: 1
                    };

                    const remote: SyncableState = {
                        state: state2,
                        timestamp: timestamp,
                        instanceId: 'instance-remote',
                        version: 1
                    };

                    const result = resolver.resolve(local, remote);
                    assert.strictEqual(result.winner, 'remote', 'Equal timestamps should result in remote winning');
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Resolved state matches winner's state
     */
    test('resolved state matches the winning state', () => {
        fc.assert(
            fc.property(syncableStateArb, syncableStateArb, (local, remote) => {
                const result = resolver.resolve(local, remote);

                const expectedState = result.winner === 'local' ? local : remote;
                assert.deepStrictEqual(result.resolvedState, expectedState);
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Same instance updates don't report conflict
     */
    test('same instance updates have null conflict details', () => {
        fc.assert(
            fc.property(
                proxyStateArb,
                proxyStateArb,
                fc.integer({ min: 0, max: 1000000000000 }),
                fc.integer({ min: 1, max: 100000 }),
                fc.uuid(),
                (state1, state2, baseTimestamp, offset, instanceId) => {
                    const local: SyncableState = {
                        state: state1,
                        timestamp: baseTimestamp,
                        instanceId: instanceId,
                        version: 1
                    };

                    const remote: SyncableState = {
                        state: state2,
                        timestamp: baseTimestamp + offset,
                        instanceId: instanceId, // Same instance
                        version: 2
                    };

                    const result = resolver.resolve(local, remote);
                    assert.strictEqual(
                        result.conflictDetails,
                        null,
                        'Same instance updates should have null conflict details'
                    );
                }
            ),
            { numRuns: 100 }
        );
    });

    /**
     * Property: Different instances report conflict details
     */
    test('different instances have conflict details when timestamps differ', () => {
        fc.assert(
            fc.property(
                proxyStateArb,
                proxyStateArb,
                fc.integer({ min: 0, max: 1000000000000 }),
                fc.integer({ min: 1, max: 100000 }),
                (state1, state2, baseTimestamp, offset) => {
                    const local: SyncableState = {
                        state: state1,
                        timestamp: baseTimestamp,
                        instanceId: 'instance-local',
                        version: 1
                    };

                    const remote: SyncableState = {
                        state: state2,
                        timestamp: baseTimestamp + offset,
                        instanceId: 'instance-remote', // Different instance
                        version: 1
                    };

                    const result = resolver.resolve(local, remote);
                    assert.ok(
                        result.conflictDetails !== null,
                        'Different instances should have conflict details'
                    );
                }
            ),
            { numRuns: 100 }
        );
    });
});
