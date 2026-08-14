/**
 * The only assurance-oracle module allowed to import production code.
 * It translates canonical test values to the production API and back; it must
 * not calculate expectations or use oracle output to drive the SUT.
 */

import { ErrorAggregator } from '../../../errors/ErrorAggregator';
import { updateProxyConfigTargetDetailed } from '../../../core/ProxyConfigTargetRunner';
import { ProxyConfigTarget } from '../../../core/ProxyApplierTypes';
import { ProxyStateManager } from '../../../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../../../core/types';
import { deriveRuntimeApplyState, ProxyIssue } from '../../../core/v3Types';
import { ConflictResolver, SyncableState } from '../../../sync/ConflictResolver';
import { ApplyInput, CanonicalMode, ModeInput, SyncInput, SyncWinner, TargetInput } from './DomainModel';

function toProductionMode(mode: CanonicalMode): ProxyMode {
    switch (mode) {
        case 'auto':
            return ProxyMode.Auto;
        case 'legacy-manual':
            return ProxyMode.Manual;
        default:
            return ProxyMode.Off;
    }
}

function bareState(input: ModeInput): ProxyState {
    return {
        mode: toProductionMode(input.mode),
        autoModeOff: input.autoModeOff,
        autoProxyUrl: input.autoProxyUrl,
        manualProxyUrl: input.manualProxyUrl
    };
}

function stateManagerWithoutStorage(): ProxyStateManager {
    return Object.create(ProxyStateManager.prototype) as ProxyStateManager;
}

export function activeProxyFromSut(input: ModeInput): string {
    return stateManagerWithoutStorage().getActiveProxyUrl(bareState(input));
}

export function nextModeFromSut(input: CanonicalMode): CanonicalMode {
    const next = stateManagerWithoutStorage().getNextMode(toProductionMode(input));
    return next === ProxyMode.Auto ? 'auto' : 'off';
}

function issueFor(kind: ApplyInput['issues'][number], index: number): ProxyIssue {
    const impact = kind === 'blocking'
        ? 'blocksConvergence'
        : kind === 'user-decision'
            ? 'requiresUserDecision'
            : 'advisoryResidualRisk';
    return {
        id: `assurance-${kind}-${index}`,
        fingerprint: `assurance-${kind}-${index}`,
        category: kind === 'blocking' ? 'applyFailed' : kind === 'user-decision' ? 'needsCredentialConsent' : 'info',
        impact,
        targetId: 'assurance-target',
        targetHost: 'workspaceHost',
        source: 'assurance-adapter',
        capability: 'supported',
        autoAction: 'none',
        userAction: 'none',
        evidence: {}
    };
}

export function applyStateFromSut(input: ApplyInput): string {
    return deriveRuntimeApplyState(
        input.issues.map(issueFor),
        input.attemptedWrite,
        input.convergedRequiredTargets,
        input.requiredTargets
    );
}

export async function targetOutcomeFromSut(input: TargetInput): Promise<{ success: boolean; outcome: string }> {
    const result = input.result === 'success'
        ? { success: true }
        : input.result === 'not-installed'
            ? { success: false, error: 'not installed', errorType: 'NOT_INSTALLED' }
            : { success: false, error: 'configuration failed', errorType: 'CONFIG_ERROR' };
    const manager = {
        setProxy: async (): Promise<typeof result> => {
            if (input.result === 'thrown') {
                throw new Error('injected target exception');
            }
            if (input.result === 'thrown-non-error') {
                // eslint-disable-next-line no-throw-literal -- Boundary code can reject with non-Error values.
                throw 'injected non-Error target exception';
            }
            return result;
        },
        unsetProxy: async (): Promise<typeof result> => {
            if (input.result === 'thrown') {
                throw new Error('injected target exception');
            }
            if (input.result === 'thrown-non-error') {
                // eslint-disable-next-line no-throw-literal -- Boundary code can reject with non-Error values.
                throw 'injected non-Error target exception';
            }
            return result;
        }
    };
    const target: ProxyConfigTarget = { name: input.targetName, manager };
    const observed = await updateProxyConfigTargetDetailed(target, input.enabled, 'safe://proxy/a', new ErrorAggregator());
    return { success: observed.success, outcome: observed.outcome };
}

function syncState(input: SyncInput, side: 'local' | 'remote'): SyncableState {
    const isLocal = side === 'local';
    return {
        state: { mode: ProxyMode.Auto },
        timestamp: isLocal ? input.localTimestamp : input.remoteTimestamp,
        instanceId: isLocal ? input.localInstanceId : input.remoteInstanceId,
        version: isLocal ? input.localVersion : input.remoteVersion
    };
}

export function syncWinnerFromSut(input: SyncInput): SyncWinner {
    return new ConflictResolver().resolve(syncState(input, 'local'), syncState(input, 'remote')).winner;
}
