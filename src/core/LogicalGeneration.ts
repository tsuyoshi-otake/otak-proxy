import { ProxyMode, ProxyState, stateRevision } from './types';

/**
 * In-memory identity of a logical proxy generation.
 *
 * Revision is the primary fence. URL identity includes username and password
 * so credential rotation and a different user are not treated as "the same
 * URL". Bypass is included so a NO_PROXY change is a new generation.
 * This object is never persisted.
 */
export interface LogicalGeneration {
    revision: number;
    mode: ProxyMode;
    autoProxyIdentity: string;
    manualProxyIdentity: string;
    fallbackProxyIdentity: string;
    noProxy: string;
}

export interface GenerationExtras {
    noProxy?: string;
}

/**
 * Stable identity for a proxy URL. Host-only comparison is not enough:
 * `http://a@proxy:8080` and `http://b@proxy:8080` are different generations.
 */
export function proxyUrlIdentity(url: string | undefined): string {
    if (!url) {
        return '';
    }

    try {
        const parsed = new URL(url);
        return [
            parsed.protocol,
            parsed.username,
            parsed.password,
            parsed.host,
            parsed.pathname,
            parsed.search
        ].join('\u0001');
    } catch {
        return url;
    }
}

export function captureLogicalGeneration(state: ProxyState, extras?: GenerationExtras): LogicalGeneration {
    return {
        revision: stateRevision(state),
        mode: state.mode,
        autoProxyIdentity: proxyUrlIdentity(state.autoProxyUrl),
        manualProxyIdentity: proxyUrlIdentity(state.manualProxyUrl),
        fallbackProxyIdentity: proxyUrlIdentity(state.fallbackProxyUrl),
        noProxy: extras?.noProxy ?? state.noProxy ?? ''
    };
}

/**
 * True when a completion captured at `started` must not mutate `current`.
 *
 * A newer revision always wins, including A→B→A and same-URL-after-restart
 * (restart bumps revision). Identity is checked as well so a caller that only
 * compared `result.url === current.url` cannot sneak through.
 */
export function sameLogicalIdentity(left: LogicalGeneration, right: LogicalGeneration): boolean {
    return left.mode === right.mode
        && left.autoProxyIdentity === right.autoProxyIdentity
        && left.manualProxyIdentity === right.manualProxyIdentity
        && left.fallbackProxyIdentity === right.fallbackProxyIdentity
        && left.noProxy === right.noProxy;
}

export function isStaleGeneration(started: LogicalGeneration, current: ProxyState, extras?: GenerationExtras): boolean {
    const now = captureLogicalGeneration(current, extras);
    if (now.revision !== started.revision) {
        return true;
    }

    return !sameLogicalIdentity(started, now);
}

export function describeGeneration(generation: LogicalGeneration): string {
    return `rev=${generation.revision} mode=${generation.mode}`;
}
