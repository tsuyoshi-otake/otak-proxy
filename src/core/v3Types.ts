import { ProxyMode } from './types';

export type ProxyValueKind = 'direct' | 'singleProxy' | 'perSchemeProxy' | 'pac' | 'wpad' | 'unknown';

export interface PublicProxyRef {
    kind: ProxyValueKind;
    scheme?: string;
    host?: string;
    port?: number;
    path?: string;
    publicUrl?: string;
}

export interface ProxyCredentials {
    username?: string;
    password?: string;
}

export interface CredentialRef {
    key: string;
    publicUrl: string;
}

export interface LamportRevision {
    counter: number;
    instanceId: string;
    createdAt: number;
}

export interface DesiredProxyState {
    mode: ProxyMode;
    normalizedProxy: ProxyValueKind;
    publicProxyRef?: PublicProxyRef;
    credentialRef?: CredentialRef;
    source: 'manualInput' | 'windowsWinInet' | 'vscodeSetting' | 'processEnv' | 'sync' | 'import' | 'unknown';
    revision: LamportRevision;
    originInstanceId: string;
    originMachineId?: string;
    originHealthSummary?: SanitizedOriginHealth;
}

export interface SanitizedOriginHealth {
    state: RuntimeApplyState;
    issueCount: number;
    highestPriorityCategory?: ProxyIssueCategory;
}

export type RuntimeApplyState = 'idle' | 'applying' | 'applied' | 'awaitingUser' | 'partial' | 'failed' | 'diagnosed';

export type ProxyIssueCategory =
    | 'managedByPolicy'
    | 'managedSuspected'
    | 'needsCredentialConsent'
    | 'needsWindowsPermission'
    | 'applyFailed'
    | 'externalOverride'
    | 'needsReload'
    | 'needsRestart'
    | 'needsNewTerminal'
    | 'autoFixed'
    | 'capabilityUnavailable'
    | 'info';

export type ProxyIssueImpact =
    | 'blocksConvergence'
    | 'requiresUserDecision'
    | 'advisoryResidualRisk'
    | 'informational';

export type ProxyCapability = 'supported' | 'unsupported' | 'readOnly' | 'parseUnavailable' | 'permissionRequired';

export type ProxyUserAction =
    | 'none'
    | 'showDetails'
    | 'changeSetting'
    | 'reloadWindow'
    | 'restartVSCode'
    | 'openNewTerminal'
    | 'runWindowsFix'
    | 'copyCommand';

export type ProxyAutoAction = 'none' | 'fixed' | 'skipped' | 'retryScheduled' | 'retrySuppressed' | 'userApprovalRequired';

export interface ProxyIssue {
    id: string;
    fingerprint: string;
    category: ProxyIssueCategory;
    impact: ProxyIssueImpact;
    targetId: string;
    targetHost: TargetHost;
    expectedSanitized?: string;
    actualSanitized?: string;
    source: string;
    capability: ProxyCapability;
    autoAction: ProxyAutoAction;
    userAction: ProxyUserAction;
    evidence: Record<string, unknown>;
}

export type UiKind = 'desktop' | 'web';
export type ExtensionHostLocation = 'localUi' | 'remoteWorkspace' | 'web' | 'unknown';
export type WorkspaceHostKind = 'localWindows' | 'localNonWindows' | 'wsl' | 'ssh' | 'devContainer' | 'codespaces' | 'web' | 'unknown';
export type TargetHost = 'windowsHost' | 'workspaceHost' | 'wsl' | 'container' | 'remote' | 'web' | 'unavailable';

export interface ExecutionContext {
    uiKind: UiKind;
    remoteName?: string;
    extensionHostLocation: ExtensionHostLocation;
    workspaceHostKind: WorkspaceHostKind;
    canUseChildProcess: boolean;
    canReadWindowsRegistry: boolean;
    canWriteVSCodeUserSettings: boolean;
    canAccessWorkspaceFiles: boolean;
}

export type OwnershipOwner = 'otakProxy' | 'external' | 'policy' | 'unknown' | 'unsupported';

export interface TargetOwnership {
    targetId: string;
    targetHost: TargetHost;
    owner: OwnershipOwner;
    publicFingerprint?: string;
    secretAwareFingerprint?: string;
    fingerprintKeyRef?: string;
    previousUserPublicFingerprint?: string;
    previousUserSecretRef?: string;
    lastSuccessfulApplyAt?: number;
    lastObservedHash?: string;
    lastObservedAt?: number;
}

export type LocalCredentialAvailability =
    | 'notRequired'
    | 'availableOnThisMachine'
    | 'missingOnThisMachine'
    | 'secretStorageUnavailable'
    | 'needsReEntry';

export type MigrationPhase =
    | 'notStarted'
    | 'secretStored'
    | 'publicStateWritten'
    | 'legacySecretScrubbed'
    | 'ownershipBootstrapped'
    | 'completed'
    | 'failed';

export interface MigrationJournal {
    schemaFrom: number;
    schemaTo: number;
    phase: MigrationPhase;
    /** The primary migrated credential (highest-priority field). */
    migratedCredentialRef?: string;
    /** Every distinct credential migrated to SecretStorage (one per public URL). */
    migratedCredentialRefs?: string[];
    /**
     * Count of distinct credentials that could not be preserved because two fields
     * shared a proxy address (public URL) with different logins — one secret per
     * public URL, so the lower-priority one is dropped and recorded here (#14).
     */
    droppedCredentialCount?: number;
    legacySecretKeyNames?: string[];
    lastErrorSanitized?: string;
}

export const V3_SCHEMA_VERSION = 3;

export const PROXY_ISSUE_PRIORITY: ProxyIssueCategory[] = [
    'managedByPolicy',
    'managedSuspected',
    'needsCredentialConsent',
    'needsWindowsPermission',
    'applyFailed',
    'externalOverride',
    'needsReload',
    'needsRestart',
    'needsNewTerminal',
    'autoFixed',
    'capabilityUnavailable',
    'info'
];

export function compareIssuePriority(a: ProxyIssueCategory, b: ProxyIssueCategory): number {
    const aIndex = PROXY_ISSUE_PRIORITY.indexOf(a);
    const bIndex = PROXY_ISSUE_PRIORITY.indexOf(b);
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
        (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
}

export function getHighestPriorityIssue(issues: readonly ProxyIssue[]): ProxyIssue | undefined {
    return [...issues].sort((a, b) => compareIssuePriority(a.category, b.category))[0];
}

export function deriveRuntimeApplyState(
    issues: readonly ProxyIssue[],
    attemptedWrite: boolean,
    convergedRequiredTargets: number,
    totalRequiredTargets: number
): RuntimeApplyState {
    if (!attemptedWrite) {
        return issues.some(issue => issue.impact === 'requiresUserDecision') ? 'awaitingUser' : 'diagnosed';
    }

    if (totalRequiredTargets === 0) {
        return issues.some(issue => issue.impact === 'requiresUserDecision') ? 'awaitingUser' : 'failed';
    }

    const hasBlockingIssue = issues.some(issue => issue.impact === 'blocksConvergence');
    if (convergedRequiredTargets === totalRequiredTargets && !hasBlockingIssue) {
        return 'applied';
    }

    if (convergedRequiredTargets > 0) {
        return 'partial';
    }

    if (issues.some(issue => issue.impact === 'requiresUserDecision')) {
        return 'awaitingUser';
    }

    return 'failed';
}
