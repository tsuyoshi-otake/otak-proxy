import { getProxyPublicUrl } from '../utils/ProxyStateSanitizer';
import {
    ProxyCapability,
    ProxyIssue,
    ProxyIssueCategory,
    ProxyIssueImpact,
    ProxyValueKind,
    TargetHost
} from './v3Types';

export type TargetRepresentability = 'representable' | 'partiallyRepresentable' | 'notRepresentable';

export type ProxyApplyTargetId = 'npm' | 'terminalEnv' | 'vscode' | 'git' | 'pip' | 'bypass';

export interface SplitProxyRequest {
    kind?: ProxyValueKind;
    httpUrl?: string;
    httpsUrl?: string;
    bypass?: string;
    source?: string | null;
}

export interface TargetCapabilityEvaluation {
    targetId: ProxyApplyTargetId;
    representability: TargetRepresentability;
    capability: ProxyCapability;
    issue?: ProxyIssue;
}

const TARGET_HOST: TargetHost = 'workspaceHost';

/**
 * Per-target capability for a detected proxy.
 *
 * npm / terminal can express HTTP and HTTPS separately.
 * VS Code `http.proxy` and pip are single-URL.
 * Git's real routing key is `http.proxy` for both HTTP and HTTPS remotes
 * (observed in #55); split HTTP=A HTTPS=B is not a complete Git apply.
 */
export function evaluateTargetCapabilities(request: SplitProxyRequest): TargetCapabilityEvaluation[] {
    const evaluations: TargetCapabilityEvaluation[] = [];
    const split = request.kind === 'perSchemeProxy' &&
        Boolean(request.httpUrl && request.httpsUrl && request.httpUrl !== request.httpsUrl);

    if (split) {
        evaluations.push(representable('npm'));
        evaluations.push(representable('terminalEnv'));
        evaluations.push(partial('git', 'git.splitProxy.notRepresentable', 'git.global.proxy', request, {
            routingKey: 'http.proxy',
            gitRouting: 'http.proxy carries HTTP and HTTPS remotes; https.proxy is not a routing key'
        }));
        evaluations.push(partial('vscode', 'vscode.splitProxy.notRepresentable', 'vscode.http.proxy', request, {
            routingKey: 'http.proxy'
        }));
        evaluations.push(partial('pip', 'pip.splitProxy.notRepresentable', 'pip.user.global.proxy', request, {
            routingKey: 'global.proxy'
        }));
    }

    if (request.bypass) {
        evaluations.push({
            targetId: 'bypass',
            representability: 'notRepresentable',
            capability: 'unsupported',
            issue: capabilityIssue(
                'system.bypass.notApplied',
                'system.bypass',
                request,
                { bypass: sanitizeEvidenceValue(request.bypass), forwarded: false }
            )
        });
    }

    return evaluations;
}

export function splitCapabilityIssues(request: SplitProxyRequest): ProxyIssue[] {
    return evaluateTargetCapabilities(request)
        .map(evaluation => evaluation.issue)
        .filter((issue): issue is ProxyIssue => Boolean(issue));
}

function representable(targetId: ProxyApplyTargetId): TargetCapabilityEvaluation {
    return {
        targetId,
        representability: 'representable',
        capability: 'supported'
    };
}

function partial(
    targetId: ProxyApplyTargetId,
    issueId: string,
    diagnosticTargetId: string,
    request: SplitProxyRequest,
    extraEvidence: Record<string, unknown>
): TargetCapabilityEvaluation {
    return {
        targetId,
        representability: 'partiallyRepresentable',
        capability: 'unsupported',
        issue: capabilityIssue(issueId, diagnosticTargetId, request, extraEvidence)
    };
}

function capabilityIssue(
    id: string,
    targetId: string,
    request: SplitProxyRequest,
    extraEvidence: Record<string, unknown>
): ProxyIssue {
    const httpPublic = sanitizeEvidenceValue(request.httpUrl);
    const httpsPublic = sanitizeEvidenceValue(request.httpsUrl);
    return {
        id,
        fingerprint: `${id}:${targetId}`,
        category: 'capabilityUnavailable' satisfies ProxyIssueCategory,
        impact: 'advisoryResidualRisk' satisfies ProxyIssueImpact,
        targetId,
        targetHost: TARGET_HOST,
        expectedSanitized: `${httpPublic ?? ''} / ${httpsPublic ?? ''}`.trim(),
        actualSanitized: httpPublic,
        source: request.source ?? 'detection',
        capability: 'unsupported',
        autoAction: 'none',
        userAction: 'showDetails',
        evidence: {
            kind: request.kind,
            httpUrl: httpPublic,
            httpsUrl: httpsPublic,
            representability: id === 'system.bypass.notApplied' ? 'notRepresentable' : 'partiallyRepresentable',
            ...extraEvidence
        }
    };
}

function sanitizeEvidenceValue(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }
    return getProxyPublicUrl(value) ?? value;
}
