import { ApplyInput, ModeInput, OracleDecision, SyncInput, TargetInput } from './DomainModel';

export interface DecisionTableRow<TInput, TValue> {
    oracleCaseId: string;
    requirements: readonly string[];
    precondition: string;
    input: TInput;
    expected: Pick<OracleDecision<TValue>, 'value' | 'terminal' | 'reasonCode'>;
    allowedEffects: readonly string[];
    prohibitedEffects: readonly string[];
}

export const MODE_DECISION_TABLE: readonly DecisionTableRow<ModeInput, string>[] = [
    {
        oracleCaseId: 'ORC-MODE-001',
        requirements: ['DVA-2.2', 'DVA-2.3', 'DVA-2.4'],
        precondition: 'Off mode has no active proxy.',
        input: { mode: 'off', autoModeOff: false, autoProxyUrl: 'safe://proxy/a' },
        expected: { value: '', terminal: 'diagnosed', reasonCode: 'mode-off' },
        allowedEffects: [],
        prohibitedEffects: ['apply-proxy']
    },
    {
        oracleCaseId: 'ORC-MODE-002',
        requirements: ['DVA-2.2', 'DVA-2.3', 'DVA-2.4'],
        precondition: 'Auto mode returns a detected or fallback URL when Auto is enabled.',
        input: { mode: 'auto', autoModeOff: false, autoProxyUrl: 'safe://proxy/a' },
        expected: { value: 'safe://proxy/a', terminal: 'applied', reasonCode: 'auto-active' },
        allowedEffects: ['apply-proxy'],
        prohibitedEffects: []
    },
    {
        oracleCaseId: 'ORC-MODE-003',
        requirements: ['DVA-2.2', 'DVA-2.3', 'DVA-2.4'],
        precondition: 'Auto OFF suppresses every candidate URL.',
        input: { mode: 'auto', autoModeOff: true, autoProxyUrl: 'safe://proxy/a' },
        expected: { value: '', terminal: 'diagnosed', reasonCode: 'auto-off' },
        allowedEffects: ['clear-proxy'],
        prohibitedEffects: ['apply-proxy']
    }
];

export const APPLY_DECISION_TABLE: readonly DecisionTableRow<ApplyInput, string>[] = [
    {
        oracleCaseId: 'ORC-APPLY-001',
        requirements: ['DVA-2.2', 'DVA-2.4', 'DVA-8.3'],
        precondition: 'A write was never attempted and user input is needed.',
        input: { attemptedWrite: false, requiredTargets: 2, convergedRequiredTargets: 0, issues: ['user-decision'] },
        expected: { value: 'awaitingUser', terminal: 'awaitingUser', reasonCode: 'no-write-user-decision' },
        allowedEffects: ['show-user-decision'],
        prohibitedEffects: ['apply-proxy']
    },
    {
        oracleCaseId: 'ORC-APPLY-002',
        requirements: ['DVA-2.2', 'DVA-2.4', 'DVA-8.3'],
        precondition: 'All required targets converge without a blocking issue.',
        input: { attemptedWrite: true, requiredTargets: 2, convergedRequiredTargets: 2, issues: ['advisory'] },
        expected: { value: 'applied', terminal: 'applied', reasonCode: 'all-required-converged' },
        allowedEffects: ['persist-result'],
        prohibitedEffects: []
    },
    {
        oracleCaseId: 'ORC-APPLY-003',
        requirements: ['DVA-2.2', 'DVA-2.4', 'DVA-8.3'],
        precondition: 'At least one, but not every, required target converges.',
        input: { attemptedWrite: true, requiredTargets: 2, convergedRequiredTargets: 1, issues: ['blocking'] },
        expected: { value: 'partial', terminal: 'partial', reasonCode: 'some-required-converged' },
        allowedEffects: ['persist-per-target-result'],
        prohibitedEffects: ['report-full-success']
    },
    {
        oracleCaseId: 'ORC-APPLY-004',
        requirements: ['DVA-2.2', 'DVA-2.4', 'DVA-8.3'],
        precondition: 'There are no required targets and no user decision can make progress.',
        input: { attemptedWrite: true, requiredTargets: 0, convergedRequiredTargets: 0, issues: [] },
        expected: { value: 'failed', terminal: 'failed', reasonCode: 'no-required-target' },
        allowedEffects: ['record-failure'],
        prohibitedEffects: ['report-full-success']
    },
    {
        oracleCaseId: 'ORC-APPLY-005',
        requirements: ['DVA-2.2', 'DVA-2.4', 'DVA-8.3'],
        precondition: 'A blocking issue prevents success even when every required target reported convergence.',
        input: { attemptedWrite: true, requiredTargets: 2, convergedRequiredTargets: 2, issues: ['blocking'] },
        expected: { value: 'partial', terminal: 'partial', reasonCode: 'some-required-converged' },
        allowedEffects: ['record-blocking-issue'],
        prohibitedEffects: ['report-full-success']
    }
];

export const TARGET_DECISION_TABLE: readonly DecisionTableRow<TargetInput, string>[] = [
    {
        oracleCaseId: 'ORC-TARGET-001',
        requirements: ['DVA-2.2', 'DVA-7.6', 'DVA-8.3'],
        precondition: 'An optional external tool is not installed.',
        input: { targetName: 'Git configuration', enabled: true, result: 'not-installed' },
        expected: { value: 'skippedUnavailable', terminal: 'diagnosed', reasonCode: 'optional-tool-unavailable' },
        allowedEffects: ['record-skip'],
        prohibitedEffects: ['record-target-failure']
    },
    {
        oracleCaseId: 'ORC-TARGET-002',
        requirements: ['DVA-2.2', 'DVA-7.6', 'DVA-8.3'],
        precondition: 'A required target reports a configuration error.',
        input: { targetName: 'VSCode configuration', enabled: true, result: 'config-error' },
        expected: { value: 'failed', terminal: 'failed', reasonCode: 'required-target-failed' },
        allowedEffects: ['record-target-failure'],
        prohibitedEffects: ['report-full-success']
    },
    {
        oracleCaseId: 'ORC-TARGET-003',
        requirements: ['DVA-2.2', 'DVA-7.6', 'DVA-8.3'],
        precondition: 'A target accepts a clear request.',
        input: { targetName: 'Terminal environment', enabled: false, result: 'success' },
        expected: { value: 'cleared', terminal: 'applied', reasonCode: 'target-cleared' },
        allowedEffects: ['clear-target'],
        prohibitedEffects: []
    },
    {
        oracleCaseId: 'ORC-TARGET-004',
        requirements: ['DVA-4.2', 'DVA-7.6', 'DVA-8.3'],
        precondition: 'A dependency can throw a non-Error value and it remains a target failure.',
        input: { targetName: 'VSCode configuration', enabled: true, result: 'thrown-non-error' },
        expected: { value: 'failed', terminal: 'failed', reasonCode: 'required-target-failed' },
        allowedEffects: ['record-target-failure'],
        prohibitedEffects: ['report-full-success']
    }
];

export const SYNC_DECISION_TABLE: readonly DecisionTableRow<SyncInput, string>[] = [
    {
        oracleCaseId: 'ORC-SYNC-001',
        requirements: ['DVA-2.2', 'DVA-3.4', 'DVA-8.5'],
        precondition: 'A remote revision has a newer valid logical timestamp.',
        input: { localTimestamp: 10, remoteTimestamp: 11, localInstanceId: 'a', remoteInstanceId: 'b', localVersion: 1, remoteVersion: 2, now: 100 },
        expected: { value: 'remote', terminal: 'applied', reasonCode: 'remote-newer' },
        allowedEffects: ['adopt-remote'],
        prohibitedEffects: ['overwrite-remote-with-stale-local']
    },
    {
        oracleCaseId: 'ORC-SYNC-002',
        requirements: ['DVA-2.2', 'DVA-3.4', 'DVA-8.5'],
        precondition: 'A remote event is older than a valid local revision.',
        input: { localTimestamp: 11, remoteTimestamp: 10, localInstanceId: 'a', remoteInstanceId: 'b', localVersion: 2, remoteVersion: 1, now: 100 },
        expected: { value: 'local', terminal: 'partial', reasonCode: 'stale-remote' },
        allowedEffects: ['reassert-local'],
        prohibitedEffects: ['adopt-stale-remote']
    },
    {
        oracleCaseId: 'ORC-SYNC-003',
        requirements: ['DVA-2.2', 'DVA-3.4', 'DVA-8.5'],
        precondition: 'The same logical write is delivered again.',
        input: { localTimestamp: 10, remoteTimestamp: 10, localInstanceId: 'a', remoteInstanceId: 'a', localVersion: 1, remoteVersion: 1, now: 100 },
        expected: { value: 'none', terminal: 'diagnosed', reasonCode: 'same-logical-write' },
        allowedEffects: [],
        prohibitedEffects: ['duplicate-apply']
    },
    {
        oracleCaseId: 'ORC-SYNC-004',
        requirements: ['DVA-2.2', 'DVA-3.4', 'DVA-8.5'],
        precondition: 'Two different instances use the same timestamp.',
        input: { localTimestamp: 10, remoteTimestamp: 10, localInstanceId: 'a', remoteInstanceId: 'b', localVersion: 1, remoteVersion: 1, now: 100 },
        expected: { value: 'remote', terminal: 'applied', reasonCode: 'equal-time-remote-tiebreak' },
        allowedEffects: ['adopt-remote'],
        prohibitedEffects: []
    }
];
