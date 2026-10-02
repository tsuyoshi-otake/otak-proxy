import { ProxyIssue, ProxyValueKind, TargetHost } from './v3Types';

export interface ProxyApplyOptions {
    silent?: boolean;
    showProgress?: boolean;
    kind?: ProxyValueKind;
    httpUrl?: string;
    httpsUrl?: string;
    bypass?: string;
}

export type ProxyConfigStatusReporter = (messageKey: string) => void;

export interface ProxyConfigOperationOptions {
    onStatus?: ProxyConfigStatusReporter;
    ownedObservations?: ReadonlyArray<{ targetId: string; value: string | null }>;
    expectedValue?: string;
}

interface ProxyConfigOperationResult {
    success: boolean;
    error?: string;
    errorType?: string;
    residualKeys?: readonly string[];
    preservedKeys?: readonly string[];
}

interface ProxyConfigManagerLike {
    setProxy(url: string, options?: ProxyConfigOperationOptions): Promise<ProxyConfigOperationResult>;
    unsetProxy(options?: ProxyConfigOperationOptions): Promise<ProxyConfigOperationResult>;
}

export type ProxyTargetOutcome =
    | 'configured'
    | 'cleared'
    | 'skippedUnavailable'
    | 'preservedExternal'
    | 'failed';

export interface ProxyConfigTargetUpdateResult {
    success: boolean;
    outcome: ProxyTargetOutcome;
    errorType?: string;
    residualKeys?: readonly string[];
}

export interface ProxyOwnershipObservation {
    targetId: string;
    value: string | null;
}

export interface ProxyOwnershipInspection {
    status: 'available' | 'unavailable' | 'error';
    observations?: ProxyOwnershipObservation[];
    error?: string;
    errorType?: string;
}

export interface OwnedTargetUnsetRequest {
    targetId: string;
    expectedValue: string;
}

export interface ProxyOwnershipAdapter {
    targets: Array<{ targetId: string; targetHost: TargetHost }>;
    applyTargetIds?: readonly string[];
    inspect(): Promise<ProxyOwnershipInspection>;
    unsetTargets(
        targets: readonly OwnedTargetUnsetRequest[],
        options?: ProxyConfigOperationOptions
    ): Promise<ProxyConfigOperationResult>;
}

export interface ProxyConfigTarget {
    name: string;
    manager: ProxyConfigManagerLike;
    ownership?: ProxyOwnershipAdapter;
}

export interface ProxyConfigResults {
    gitSuccess: boolean;
    vscodeSuccess: boolean;
    npmSuccess: boolean;
    pipSuccess?: boolean;
    terminalEnvSuccess: boolean;
    gitOutcome?: ProxyTargetOutcome;
    vscodeOutcome?: ProxyTargetOutcome;
    npmOutcome?: ProxyTargetOutcome;
    pipOutcome?: ProxyTargetOutcome;
    terminalEnvOutcome?: ProxyTargetOutcome;
}

export interface ProxyApplyDetailedResult {
    success: boolean;
    enabled: boolean;
    proxyUrl: string;
    results: ProxyConfigResults;
    errors: Array<{
        target: string;
        message: string;
        errorType?: string;
    }>;
    issues?: ProxyIssue[];
    /**
     * True when the apply was skipped because a newer logical generation
     * replaced the one it was started for. Nothing was written; `success` only
     * means "no work is owed for this generation", never that targets converged.
     */
    superseded?: boolean;
    /**
     * Revision written by this apply's own result commit. Undefined when that
     * commit was discarded as stale, could not be attributed, or was not
     * reported (blocked applies). Only a reported revision lets a generation
     * fence treat the revision change as its own (#78).
     */
    committedRevision?: number;
}
