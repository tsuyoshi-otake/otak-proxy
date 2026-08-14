import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    APPLY_DECISION_TABLE,
    MODE_DECISION_TABLE,
    SYNC_DECISION_TABLE,
    TARGET_DECISION_TABLE
} from './oracle/DecisionTables';
import {
    expectedActiveProxy,
    expectedApplyState,
    expectedNextMode,
    expectedSyncWinner,
    expectedTargetOutcome,
    reduceLifecycle
} from './oracle/DomainOracle';
import { ModeInput } from './oracle/DomainModel';
import {
    activeProxyFromSut,
    applyStateFromSut,
    nextModeFromSut,
    syncWinnerFromSut,
    targetOutcomeFromSut
} from './oracle/SUTAdapters';

suite('Assurance: independent domain oracle examples', () => {
    test('oracle modules do not import production source', () => {
        const oracleRoot = path.join(process.cwd(), 'src', 'test', 'assurance', 'oracle');
        const oracleFiles = ['DomainModel.ts', 'DecisionTables.ts', 'DomainOracle.ts'];
        for (const file of oracleFiles) {
            const source = fs.readFileSync(path.join(oracleRoot, file), 'utf8');
            assert.ok(!/from\s+['"][^'"]*(?:\/core\/|\/sync\/|\/config\/|\/monitoring\/|\/remediation\/)/u.test(source),
                `${file} must not import a production module`);
            assert.ok(!/from\s+['"]vscode['"]/u.test(source), `${file} must not import vscode`);
        }
    });

    for (const row of MODE_DECISION_TABLE) {
        test(`${row.oracleCaseId}: ${row.precondition}`, () => {
            const expected = expectedActiveProxy(row.input);
            assert.strictEqual(expected.value, row.expected.value);
            assert.strictEqual(expected.terminal, row.expected.terminal);
            assert.strictEqual(expected.reasonCode, row.expected.reasonCode);
            assert.strictEqual(activeProxyFromSut(row.input), expected.value);
        });
    }

    test('ORC-MODE-004: Off and Auto form the supported toggle cycle', () => {
        assert.strictEqual(expectedNextMode('off').value, 'auto');
        assert.strictEqual(expectedNextMode('auto').value, 'off');
        assert.strictEqual(nextModeFromSut('off'), 'auto');
        assert.strictEqual(nextModeFromSut('auto'), 'off');
        // Legacy values are a migration input, never a third supported target mode.
        assert.strictEqual(nextModeFromSut('legacy-manual'), 'auto');
    });

    for (const row of APPLY_DECISION_TABLE) {
        test(`${row.oracleCaseId}: ${row.precondition}`, () => {
            const expected = expectedApplyState(row.input);
            assert.strictEqual(expected.value, row.expected.value);
            assert.strictEqual(expected.terminal, row.expected.terminal);
            assert.strictEqual(expected.reasonCode, row.expected.reasonCode);
            assert.strictEqual(applyStateFromSut(row.input), expected.value);
        });
    }

    for (const row of TARGET_DECISION_TABLE) {
        test(`${row.oracleCaseId}: ${row.precondition}`, async () => {
            const expected = expectedTargetOutcome(row.input);
            assert.strictEqual(expected.value.outcome, row.expected.value);
            assert.strictEqual(expected.terminal, row.expected.terminal);
            assert.strictEqual(expected.reasonCode, row.expected.reasonCode);
            assert.deepStrictEqual(await targetOutcomeFromSut(row.input), expected.value);
        });
    }

    for (const row of SYNC_DECISION_TABLE) {
        test(`${row.oracleCaseId}: ${row.precondition}`, () => {
            const expected = expectedSyncWinner(row.input);
            assert.strictEqual(expected.value, row.expected.value);
            assert.strictEqual(expected.terminal, row.expected.terminal);
            assert.strictEqual(expected.reasonCode, row.expected.reasonCode);
            assert.strictEqual(syncWinnerFromSut(row.input), expected.value);
        });
    }

    test('ORC-SYNC-005: a future remote timestamp is rejected', () => {
        const now = Date.now();
        const input = {
            localTimestamp: now,
            remoteTimestamp: now + 30_001,
            localInstanceId: 'local',
            remoteInstanceId: 'remote',
            localVersion: 1,
            remoteVersion: 2,
            now
        };
        assert.strictEqual(expectedSyncWinner(input).value, 'local');
        assert.strictEqual(syncWinnerFromSut(input), 'local');
    });

    test('ORC-SYNC-006: a future local timestamp is rejected in favor of a valid remote state', () => {
        const now = Date.now();
        const input = {
            localTimestamp: now + 60_000,
            remoteTimestamp: now,
            localInstanceId: 'local',
            remoteInstanceId: 'remote',
            localVersion: 2,
            remoteVersion: 1,
            now
        };
        assert.strictEqual(expectedSyncWinner(input).value, 'remote');
        assert.strictEqual(syncWinnerFromSut(input), 'remote');
    });

    test('ORC-SYNC-007: two future timestamps remain outside the valid-time ordering domain', () => {
        const now = Date.now();
        const input = {
            localTimestamp: now + 60_001,
            remoteTimestamp: now + 60_000,
            localInstanceId: 'local',
            remoteInstanceId: 'remote',
            localVersion: 2,
            remoteVersion: 1,
            now
        };
        assert.strictEqual(expectedSyncWinner(input).value, 'local');
        assert.strictEqual(syncWinnerFromSut(input), 'local');
    });

    test('ORC-LIFECYCLE-001: late completion after stop cannot re-enable effects', () => {
        const lifecycle = reduceLifecycle(['start', 'begin', 'stop', 'complete']);
        assert.deepStrictEqual(lifecycle, {
            state: 'stopped',
            terminal: 'stopped',
            sideEffectsAllowed: false
        });
    });

    test('ORC-RECOVERY-001: crash, restart and recovery restore a distinct recovered terminal state', () => {
        const lifecycle = reduceLifecycle(['start', 'begin', 'crash', 'restart', 'recover']);
        assert.deepStrictEqual(lifecycle, {
            state: 'running',
            terminal: 'recovered',
            sideEffectsAllowed: true
        });
    });

    test('negative control: an implementation that ignores Auto OFF is rejected', () => {
        const input: ModeInput = { mode: 'auto', autoModeOff: true, autoProxyUrl: 'safe://proxy/a' };
        const knownBadActiveProxy = (candidate: ModeInput): string => candidate.autoProxyUrl ?? '';
        assert.notStrictEqual(knownBadActiveProxy(input), expectedActiveProxy(input).value);
    });

    test('negative control: a stale remote winner is rejected', () => {
        const input = {
            localTimestamp: 9,
            remoteTimestamp: 8,
            localInstanceId: 'local',
            remoteInstanceId: 'remote',
            localVersion: 2,
            remoteVersion: 1,
            now: 10
        };
        const knownBadWinner = (): 'remote' => 'remote';
        assert.notStrictEqual(knownBadWinner(), expectedSyncWinner(input).value);
    });
});
