import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as fc from 'fast-check';
import {
    expectedActiveProxy,
    expectedApplyState,
    expectedSyncWinner,
    expectedTargetOutcome,
    reduceLifecycle
} from './oracle/DomainOracle';
import { ApplyInput, CanonicalMode, LifecycleEvent, ModeInput, SyncInput, TargetInput } from './oracle/DomainModel';
import {
    activeProxyFromSut,
    applyStateFromSut,
    syncWinnerFromSut,
    targetOutcomeFromSut
} from './oracle/SUTAdapters';
import { recordFromFastCheck, writePbtRecord } from './support/PbtLedger';

interface ReplayFixture {
    generatorVersions: Record<string, string>;
    fixedSeeds: Record<string, number[]>;
}

function fixtures(): ReplayFixture {
    const fixturePath = path.join(
        process.cwd(),
        '.kiro',
        'specs',
        'domain-verification-assurance',
        'evidence',
        'pbt',
        'replay-fixtures.json'
    );
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ReplayFixture;
}

function configuredRuns(): number {
    const explicit = Number(process.env.OTAK_PROXY_PROPERTY_RUNS);
    if (Number.isInteger(explicit) && explicit > 0) {
        return explicit;
    }
    return process.env.OTAK_PROXY_TEST_FAST === '1' ? 12 : 50;
}

async function recordAndAssert(
    propertyId: string,
    result: { failed?: boolean; error?: unknown; seed?: number; counterexamplePath?: string | null; counterexample?: unknown; numRuns?: number; numSkips?: number; numShrinks?: number },
    status: 'passed' | 'failed' | 'calibrated' = result.failed ? 'failed' : 'passed'
): Promise<void> {
    const fixture = fixtures();
    const record = recordFromFastCheck(
        propertyId,
        result,
        fixture.generatorVersions[propertyId],
        ['DVA-3.1', 'DVA-3.2', 'DVA-3.3', 'DVA-3.4', 'DVA-3.5', 'DVA-3.6', 'DVA-3.7'],
        status
    );
    await writePbtRecord(record);
    if (status === 'passed') {
        assert.strictEqual(result.failed, false, String(result.error ?? `${propertyId} failed`));
    } else {
        assert.strictEqual(result.failed, true, `${propertyId} must fail as a calibration control`);
        assert.ok(record.counterexample !== null, `${propertyId} must save a shrunk counterexample`);
        assert.ok(record.path, `${propertyId} must save a replay path`);
    }
}

function safeUrlArbitrary(): fc.Arbitrary<string | undefined> {
    return fc.option(
        fc.integer({ min: 0, max: 9_999 }).map(index => `safe://proxy/${index}`),
        { nil: undefined }
    );
}

const modeInputArbitrary: fc.Arbitrary<ModeInput> = fc.record({
    mode: fc.constantFrom<CanonicalMode>('off', 'auto', 'legacy-manual'),
    autoModeOff: fc.boolean(),
    autoProxyUrl: safeUrlArbitrary(),
    manualProxyUrl: safeUrlArbitrary()
});

const applyInputArbitrary: fc.Arbitrary<ApplyInput> = fc.integer({ min: 0, max: 4 }).chain(requiredTargets =>
    fc.record({
        attemptedWrite: fc.boolean(),
        requiredTargets: fc.constant(requiredTargets),
        convergedRequiredTargets: fc.integer({ min: 0, max: requiredTargets }),
        issues: fc.array(fc.constantFrom<ApplyInput['issues'][number]>('blocking', 'user-decision', 'advisory'), { maxLength: 3 })
    })
);

const targetInputArbitrary: fc.Arbitrary<TargetInput> = fc.record({
    targetName: fc.constantFrom<TargetInput['targetName']>(
        'Git configuration',
        'npm configuration',
        'pip configuration',
        'VSCode configuration',
        'Terminal environment'
    ),
    enabled: fc.boolean(),
    result: fc.constantFrom<TargetInput['result']>('success', 'not-installed', 'config-error', 'thrown', 'thrown-non-error')
});

const syncInputArbitrary: fc.Arbitrary<SyncInput> = fc.record({
    localTimestamp: fc.integer({ min: 0, max: 1_000 }),
    remoteTimestamp: fc.integer({ min: 0, max: 1_000 }),
    localInstanceId: fc.constantFrom('actor-a', 'actor-b'),
    remoteInstanceId: fc.constantFrom('actor-a', 'actor-b'),
    localVersion: fc.integer({ min: 0, max: 5 }),
    remoteVersion: fc.integer({ min: 0, max: 5 }),
    now: fc.constant(2_000)
});

const lifecycleEventsArbitrary = fc.array(
    fc.constantFrom<LifecycleEvent>('start', 'begin', 'complete', 'stop', 'cancel', 'timeout', 'crash', 'restart', 'recover'),
    { minLength: 1, maxLength: 20 }
);

suite('Assurance: persisted property-based tests', () => {
    const fixture = fixtures();
    const numRuns = configuredRuns();

    test('PBT-MODE-001: canonical mode decisions agree with the SUT for every stored seed', async () => {
        const property = fc.property(modeInputArbitrary, input => {
            assert.strictEqual(activeProxyFromSut(input), expectedActiveProxy(input).value);
        });
        for (const seed of fixture.fixedSeeds['PBT-MODE-001']) {
            const result = fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-MODE-001', result);
        }
    });

    test('PBT-APPLY-001: required-target aggregation agrees with the independent table', async () => {
        const property = fc.property(applyInputArbitrary, input => {
            assert.strictEqual(applyStateFromSut(input), expectedApplyState(input).value);
        });
        for (const seed of fixture.fixedSeeds['PBT-APPLY-001']) {
            const result = fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-APPLY-001', result);
        }
    });

    test('PBT-TARGET-001: optional-tool skip and failure stay distinguishable', async () => {
        const property = fc.asyncProperty(targetInputArbitrary, async input => {
            assert.deepStrictEqual(await targetOutcomeFromSut(input), expectedTargetOutcome(input).value);
        });
        for (const seed of fixture.fixedSeeds['PBT-TARGET-001']) {
            const result = await fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-TARGET-001', result);
        }
    });

    test('PBT-SYNC-001: duplicate and reordered logical writes never choose a stale winner', async () => {
        const property = fc.property(syncInputArbitrary, input => {
            assert.strictEqual(syncWinnerFromSut(input), expectedSyncWinner(input).value);
        });
        for (const seed of fixture.fixedSeeds['PBT-SYNC-001']) {
            const result = fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-SYNC-001', result);
        }
    });

    test('PBT-LIFECYCLE-001: a stop or cancel at the end of an event sequence forbids later effects', async () => {
        const property = fc.property(lifecycleEventsArbitrary, events => {
            const terminated = reduceLifecycle([...events, 'stop', 'complete']);
            assert.strictEqual(terminated.sideEffectsAllowed, false);
            assert.strictEqual(terminated.state, 'stopped');
        });
        for (const seed of fixture.fixedSeeds['PBT-LIFECYCLE-001']) {
            const result = fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-LIFECYCLE-001', result);
        }
    });

    test('PBT-RECOVERY-001: crash/restart/recover returns to a running state without permitting a pre-restart completion', async () => {
        const property = fc.property(lifecycleEventsArbitrary, prefix => {
            const recovered = reduceLifecycle([...prefix, 'crash', 'restart', 'recover']);
            assert.strictEqual(recovered.state, 'running');
            assert.strictEqual(recovered.terminal, 'recovered');
            assert.strictEqual(recovered.sideEffectsAllowed, true);
        });
        for (const seed of fixture.fixedSeeds['PBT-RECOVERY-001']) {
            const result = fc.check(property, { seed, numRuns });
            await recordAndAssert('PBT-RECOVERY-001', result);
        }
    });

    test('PBT-CAL-001: known-bad Auto OFF behavior fails, shrinks, and replays', async () => {
        const knownBadInput = fc.integer({ min: 2, max: 100 }).map(size => ({
            mode: 'auto' as const,
            autoModeOff: true,
            autoProxyUrl: `safe://proxy/${'x'.repeat(size)}`
        }));
        const knownBadProperty = fc.property(knownBadInput, input => {
            // Deliberately wrong implementation: it ignores Auto OFF.
            const knownBadActual = input.autoProxyUrl ?? '';
            assert.strictEqual(knownBadActual, expectedActiveProxy(input).value);
        });
        const seed = fixture.fixedSeeds['PBT-CAL-001'][0];
        const result = fc.check(knownBadProperty, { seed, numRuns });
        await recordAndAssert('PBT-CAL-001', result, 'calibrated');
        assert.ok((result.numShrinks ?? 0) > 0, 'calibration must demonstrate shrink');

        assert.ok(result.counterexamplePath, 'calibration must provide a replay path');
        const replay = fc.check(knownBadProperty, {
            seed: result.seed,
            path: result.counterexamplePath,
            numRuns: 1
        });
        assert.strictEqual(replay.failed, true, 'saved seed/path must reproduce the calibration failure');
        assert.deepStrictEqual(replay.counterexample, result.counterexample);
    });
});
