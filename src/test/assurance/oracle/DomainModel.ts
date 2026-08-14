/**
 * Canonical model for the assurance suite.
 *
 * This module deliberately has no imports from src production code. It uses
 * literal values derived from approved requirements, so an implementation and
 * its expected result cannot accidentally share a helper or a condition.
 */

export type CanonicalMode = 'off' | 'auto' | 'legacy-manual';

export type TerminalState =
    | 'diagnosed'
    | 'applied'
    | 'partial'
    | 'failed'
    | 'awaitingUser'
    | 'cancelled'
    | 'timeout'
    | 'stopped'
    | 'recovered'
    | 'degraded';

export interface OracleDecision<T> {
    value: T;
    terminal: TerminalState;
    allowedEffects: readonly string[];
    prohibitedEffects: readonly string[];
    reasonCode: string;
    requirements: readonly string[];
}

export interface ModeInput {
    mode: CanonicalMode;
    autoModeOff: boolean;
    autoProxyUrl?: string;
    manualProxyUrl?: string;
}

export type IssueKind = 'blocking' | 'user-decision' | 'advisory';

export interface ApplyInput {
    attemptedWrite: boolean;
    requiredTargets: number;
    convergedRequiredTargets: number;
    issues: readonly IssueKind[];
}

export type TargetResult = 'success' | 'not-installed' | 'config-error' | 'thrown' | 'thrown-non-error';

export interface TargetInput {
    targetName: 'Git configuration' | 'npm configuration' | 'pip configuration' | 'VSCode configuration' | 'Terminal environment';
    enabled: boolean;
    result: TargetResult;
}

export type TargetOutcome = 'configured' | 'cleared' | 'skippedUnavailable' | 'failed';

export interface TargetDecision {
    success: boolean;
    outcome: TargetOutcome;
}

export interface SyncInput {
    localTimestamp: number;
    remoteTimestamp: number;
    localInstanceId: string;
    remoteInstanceId: string;
    localVersion: number;
    remoteVersion: number;
    now: number;
}

export type SyncWinner = 'local' | 'remote' | 'none';

export type LifecycleEvent = 'start' | 'begin' | 'complete' | 'stop' | 'cancel' | 'timeout' | 'crash' | 'restart' | 'recover';

export interface LifecycleDecision {
    state: 'stopped' | 'running' | 'checking' | 'crashed' | 'recovering';
    terminal: TerminalState | null;
    sideEffectsAllowed: boolean;
}

export const MAX_LOGICAL_CLOCK_DRIFT = 30_000;
