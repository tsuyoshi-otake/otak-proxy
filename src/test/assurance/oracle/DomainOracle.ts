import {
    ApplyInput,
    CanonicalMode,
    LifecycleDecision,
    LifecycleEvent,
    MAX_LOGICAL_CLOCK_DRIFT,
    ModeInput,
    OracleDecision,
    SyncInput,
    SyncWinner,
    TargetDecision,
    TargetInput
} from './DomainModel';

function decision<T>(
    value: T,
    terminal: OracleDecision<T>['terminal'],
    reasonCode: string,
    requirements: readonly string[],
    allowedEffects: readonly string[] = [],
    prohibitedEffects: readonly string[] = []
): OracleDecision<T> {
    return { value, terminal, reasonCode, requirements, allowedEffects, prohibitedEffects };
}

export function expectedActiveProxy(input: ModeInput): OracleDecision<string> {
    if (input.mode === 'off') {
        return decision('', 'diagnosed', 'mode-off', ['DVA-2.2', 'DVA-2.4'], [], ['apply-proxy']);
    }

    if (input.mode === 'legacy-manual') {
        return decision(input.manualProxyUrl ?? '', 'diagnosed', 'legacy-manual-input', ['DVA-1.3'], [], []);
    }

    if (input.autoModeOff) {
        return decision('', 'diagnosed', 'auto-off', ['DVA-2.2', 'DVA-2.4'], ['clear-proxy'], ['apply-proxy']);
    }

    const active = input.autoProxyUrl ?? '';
    return decision(
        active,
        active === '' ? 'diagnosed' : 'applied',
        active === '' ? 'auto-no-candidate' : 'auto-active',
        ['DVA-2.2', 'DVA-2.4'],
        active === '' ? [] : ['apply-proxy'],
        []
    );
}

export function expectedNextMode(current: CanonicalMode): OracleDecision<CanonicalMode> {
    const next: CanonicalMode = current === 'auto' ? 'off' : 'auto';
    return decision(next, 'diagnosed', `toggle-${current}-to-${next}`, ['DVA-1.3', 'DVA-2.2']);
}

export function expectedApplyState(input: ApplyInput): OracleDecision<'diagnosed' | 'awaitingUser' | 'applied' | 'partial' | 'failed'> {
    const asksForUser = input.issues.includes('user-decision');
    const blocksConvergence = input.issues.includes('blocking');

    if (!input.attemptedWrite) {
        return asksForUser
            ? decision('awaitingUser', 'awaitingUser', 'no-write-user-decision', ['DVA-2.2', 'DVA-2.4'])
            : decision('diagnosed', 'diagnosed', 'no-write-diagnosed', ['DVA-2.2', 'DVA-2.4']);
    }

    if (input.requiredTargets === 0) {
        return asksForUser
            ? decision('awaitingUser', 'awaitingUser', 'no-required-user-decision', ['DVA-2.2', 'DVA-2.4'])
            : decision('failed', 'failed', 'no-required-target', ['DVA-2.2', 'DVA-8.3'], ['record-failure'], ['report-full-success']);
    }

    if (input.convergedRequiredTargets === input.requiredTargets && !blocksConvergence) {
        return decision('applied', 'applied', 'all-required-converged', ['DVA-2.2', 'DVA-2.4'], ['persist-result']);
    }

    if (input.convergedRequiredTargets !== 0) {
        return decision('partial', 'partial', 'some-required-converged', ['DVA-2.4', 'DVA-8.3'], ['persist-per-target-result'], ['report-full-success']);
    }

    return asksForUser
        ? decision('awaitingUser', 'awaitingUser', 'zero-converged-user-decision', ['DVA-2.4'])
        : decision('failed', 'failed', 'zero-converged-failed', ['DVA-2.4', 'DVA-8.3'], ['record-failure'], ['report-full-success']);
}

export function expectedTargetOutcome(input: TargetInput): OracleDecision<TargetDecision> {
    const isOptionalTool = input.targetName === 'Git configuration' ||
        input.targetName === 'npm configuration' ||
        input.targetName === 'pip configuration';

    if (input.result === 'not-installed' && isOptionalTool) {
        return decision(
            { success: true, outcome: 'skippedUnavailable' },
            'diagnosed',
            'optional-tool-unavailable',
            ['DVA-2.4', 'DVA-7.6'],
            ['record-skip'],
            ['record-target-failure']
        );
    }

    if (input.result !== 'success') {
        return decision(
            { success: false, outcome: 'failed' },
            'failed',
            'required-target-failed',
            ['DVA-2.4', 'DVA-8.3'],
            ['record-target-failure'],
            ['report-full-success']
        );
    }

    return input.enabled
        ? decision({ success: true, outcome: 'configured' }, 'applied', 'target-configured', ['DVA-2.4'])
        : decision({ success: true, outcome: 'cleared' }, 'applied', 'target-cleared', ['DVA-2.4']);
}

export function expectedSyncWinner(input: SyncInput): OracleDecision<SyncWinner> {
    const remoteValid = input.remoteTimestamp <= input.now + MAX_LOGICAL_CLOCK_DRIFT;
    const localValid = input.localTimestamp <= input.now + MAX_LOGICAL_CLOCK_DRIFT;

    if (!remoteValid && localValid) {
        return decision('local', 'partial', 'reject-future-remote', ['DVA-2.4', 'DVA-8.5'], ['reassert-local'], ['adopt-stale-remote']);
    }

    if (!localValid && remoteValid) {
        return decision('remote', 'applied', 'reject-future-local', ['DVA-2.4', 'DVA-8.5'], ['adopt-remote']);
    }

    if (input.localVersion === input.remoteVersion &&
        input.localTimestamp === input.remoteTimestamp &&
        input.localInstanceId === input.remoteInstanceId) {
        return decision('none', 'diagnosed', 'same-logical-write', ['DVA-3.4', 'DVA-8.5'], [], ['duplicate-apply']);
    }

    if (input.remoteTimestamp > input.localTimestamp) {
        return decision('remote', 'applied', 'remote-newer', ['DVA-2.4', 'DVA-8.5'], ['adopt-remote']);
    }

    if (input.localTimestamp > input.remoteTimestamp) {
        return decision('local', 'partial', 'stale-remote', ['DVA-2.4', 'DVA-8.5'], ['reassert-local'], ['adopt-stale-remote']);
    }

    return decision('remote', 'applied', 'equal-time-remote-tiebreak', ['DVA-2.4', 'DVA-8.5'], ['adopt-remote']);
}

export function reduceLifecycle(events: readonly LifecycleEvent[]): LifecycleDecision {
    let state: LifecycleDecision['state'] = 'stopped';
    let terminal: LifecycleDecision['terminal'] = 'stopped';
    let sideEffectsAllowed = false;

    for (const event of events) {
        switch (event) {
            case 'start':
                state = 'running';
                terminal = null;
                sideEffectsAllowed = true;
                break;
            case 'begin':
                if (state === 'running') {
                    state = 'checking';
                }
                break;
            case 'complete':
                if (state === 'checking') {
                    state = 'running';
                }
                break;
            case 'stop':
            case 'cancel':
                state = 'stopped';
                terminal = event === 'cancel' ? 'cancelled' : 'stopped';
                sideEffectsAllowed = false;
                break;
            case 'timeout':
                terminal = 'timeout';
                state = 'running';
                sideEffectsAllowed = false;
                break;
            case 'crash':
                state = 'crashed';
                terminal = 'failed';
                sideEffectsAllowed = false;
                break;
            case 'restart':
                if (state === 'crashed') {
                    state = 'recovering';
                    terminal = null;
                }
                break;
            case 'recover':
                if (state === 'recovering') {
                    state = 'running';
                    terminal = 'recovered';
                    sideEffectsAllowed = true;
                }
                break;
        }
    }

    return { state, terminal, sideEffectsAllowed };
}
