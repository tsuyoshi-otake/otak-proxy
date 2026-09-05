/**
 * Public proxy identity: credential-free WHATWG href used for comparison.
 * Bracketed IPv6 authorities may omit the scheme (`[::1]:8080`).
 * DNS/IPv4 scheme-less values stay as-is so existing comparisons do not change.
 */
export function toPublicProxyHref(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : trimmed.startsWith('[')
            ? `http://${trimmed}`
            : trimmed;

    try {
        const parsed = new URL(candidate);
        if (!parsed.hostname) {
            return undefined;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return undefined;
    }
}

export function normalizeProxyForComparison(value: string): string {
    return toPublicProxyHref(value) ?? value.trim();
}
