import { TargetHost } from './v3Types';

export interface ProxyApplyOptions {
    silent?: boolean;
    showProgress?: boolean;
}

export type ProxyConfigStatusReporter = (messageKey: string) => void;

export interface ProxyConfigOperationOptions {
    onStatus?: ProxyConfigStatusReporter;
}

interface ProxyConfigOperationResult {
    success: boolean;
    error?: string;
    errorType?: string;
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

export interface ProxyOwnershipAdapter {
    targets: Array<{ targetId: string; targetHost: TargetHost }>;
    inspect(): Promise<ProxyOwnershipInspection>;
    unsetTargets(targetIds: readonly string[], options?: ProxyConfigOperationOptions): Promise<ProxyConfigOperationResult>;
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
}
