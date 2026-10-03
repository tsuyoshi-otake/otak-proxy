import type { AppliedProxySource, ProxyState } from '../core/types';
import type { ProxyValueKind } from '../core/v3Types';
import type { DetectionSource, ProxyDetectionWithSource } from './SystemProxyDetector';

/**
 * Builds a detection result that keeps HTTP and HTTPS distinct.
 * A single `proxyUrl` is only a display/primary value — never a claim that
 * split routing was collapsed successfully.
 */
export function buildDetectedProxyValue(input: {
    http?: string | null;
    https?: string | null;
    bypass?: string | null;
    source: DetectionSource;
}): ProxyDetectionWithSource {
    const httpUrl = normalizeProxyEndpoint(input.http);
    const httpsUrl = normalizeProxyEndpoint(input.https);
    const bypass = normalizeOptional(input.bypass);

    if (!httpUrl && !httpsUrl) {
        return {
            proxyUrl: null,
            source: null,
            kind: 'direct',
            capability: 'supported',
            bypass
        };
    }

    if (!httpUrl || !httpsUrl || httpUrl === httpsUrl) {
        const proxyUrl = httpUrl ?? httpsUrl!;
        return {
            proxyUrl,
            source: input.source,
            kind: 'singleProxy',
            capability: 'supported',
            httpUrl: httpUrl ?? (httpsUrl === proxyUrl ? proxyUrl : undefined),
            httpsUrl: httpsUrl ?? (httpUrl === proxyUrl ? proxyUrl : undefined),
            bypass
        };
    }

    return {
        proxyUrl: httpUrl,
        source: input.source,
        kind: 'perSchemeProxy',
        capability: 'supported',
        httpUrl,
        httpsUrl,
        bypass
    };
}

export function isPerSchemeProxy(kind: ProxyValueKind | undefined, httpUrl?: string, httpsUrl?: string): boolean {
    return kind === 'perSchemeProxy' && Boolean(httpUrl && httpsUrl && httpUrl !== httpsUrl);
}

export function normalizeProxyEndpoint(value?: string | null): string | undefined {
    const trimmed = normalizeOptional(value);
    if (!trimmed) {
        return undefined;
    }
    return hasUrlScheme(trimmed) ? trimmed : `http://${trimmed}`;
}

function normalizeOptional(value?: string | null): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function hasUrlScheme(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function assignDetectedProxyToState(state: ProxyState, detected: ProxyDetectionWithSource): void {
    state.autoProxyUrl = detected.proxyUrl ?? undefined;
    state.autoProxyKind = detected.kind;
    state.autoHttpProxyUrl = detected.httpUrl;
    state.autoHttpsProxyUrl = detected.httpsUrl;
    state.detectedBypass = detected.bypass;
    state.lastDetectionSource = (detected.source ?? undefined) as AppliedProxySource | undefined;
}

export function clearDetectedSplitFields(state: ProxyState): void {
    state.autoProxyKind = undefined;
    state.autoHttpProxyUrl = undefined;
    state.autoHttpsProxyUrl = undefined;
    state.detectedBypass = undefined;
}

/** The split fields, as a detection result or the committed state carries them. */
export interface SplitRoutingFields {
    kind?: ProxyValueKind;
    httpUrl?: string;
    httpsUrl?: string;
    bypass?: string;
}

/** The split fields that change routing, or undefined when apply ignores them. */
function routingSplit(fields: SplitRoutingFields): SplitRoutingFields | undefined {
    if (!isPerSchemeProxy(fields.kind, fields.httpUrl, fields.httpsUrl) && !fields.bypass) {
        return undefined;
    }
    return {
        kind: fields.kind,
        httpUrl: fields.httpUrl,
        httpsUrl: fields.httpsUrl,
        bypass: fields.bypass
    };
}

export function splitApplyOptionsFromState(state: ProxyState): SplitRoutingFields | undefined {
    return routingSplit({
        kind: state.autoProxyKind,
        httpUrl: state.autoHttpProxyUrl,
        httpsUrl: state.autoHttpsProxyUrl,
        bypass: state.detectedBypass
    });
}

/**
 * What a detection's split fields change about routing, as a comparable
 * string. Fields that apply ignores (a single proxy's own http/https copies)
 * do not count, so an unchanged detection does not trigger a needless apply.
 */
export function detectionSplitRoutingIdentity(detection: SplitRoutingFields): string {
    return JSON.stringify(routingSplit(detection) ?? null);
}

/** {@link detectionSplitRoutingIdentity} for the split fields committed in state. */
export function splitRoutingIdentity(state: ProxyState): string {
    return JSON.stringify(splitApplyOptionsFromState(state) ?? null);
}
