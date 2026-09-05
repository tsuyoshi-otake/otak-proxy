import {
    ProxyCapability,
    ProxyIssue,
    ProxyIssueCategory,
    ProxyIssueImpact,
    ProxyValueKind,
    TargetHost
} from '../core/v3Types';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';

const redactor = new ProxySecretRedactor();

export type UnsupportedAutoConfigKind = Extract<ProxyValueKind, 'pac' | 'wpad'>;

export interface UnsupportedAutoConfigIssueParams {
    id: string;
    targetId: string;
    targetHost: TargetHost;
    source: string;
    kind: UnsupportedAutoConfigKind;
    autoConfigUrl?: string;
    evidence?: Record<string, unknown>;
}

/**
 * Shared ProxyIssue for platform auto-config that otak-proxy can observe but
 * cannot apply (no PAC/WPAD engine). Diagnose and Auto must emit the same
 * category / capability / kind (#58).
 */
export function createUnsupportedAutoConfigIssue(params: UnsupportedAutoConfigIssueParams): ProxyIssue {
    const sanitizedUrl = params.autoConfigUrl
        ? redactor.redactString(params.autoConfigUrl)
        : undefined;
    const evidence: Record<string, unknown> = {
        kind: params.kind,
        ...(sanitizedUrl ? { autoConfigUrl: sanitizedUrl } : {}),
        ...(params.evidence ?? {})
    };

    return {
        id: params.id,
        fingerprint: sanitizedUrl ? `${params.id}:${sanitizedUrl}` : params.id,
        category: 'capabilityUnavailable' satisfies ProxyIssueCategory,
        impact: 'blocksConvergence' satisfies ProxyIssueImpact,
        targetId: params.targetId,
        targetHost: params.targetHost,
        actualSanitized: sanitizedUrl,
        source: params.source,
        capability: 'unsupported' satisfies ProxyCapability,
        autoAction: 'none',
        userAction: 'showDetails',
        evidence
    };
}

export function unsupportedAutoConfigKindLabel(kind: ProxyValueKind | undefined): string {
    return kind === 'wpad' ? 'WPAD' : 'PAC';
}
