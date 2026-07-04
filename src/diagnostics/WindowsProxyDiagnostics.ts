import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProxyIssue } from '../core/v3Types';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';

const execFileAsync = promisify(execFile);

export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsProxyObservation {
    winHttpProxy?: string | null;
    winHttpBypass?: string | null;
    winHttpParseStatus: 'parsed' | 'parseUnavailable' | 'unavailable';
    winInetProxyEnable?: boolean;
    winInetProxyServer?: string;
    winInetAutoConfigUrl?: string;
    winInetProxyOverride?: string;
}

const DEFAULT_RUNNER: CommandRunner = async (command, args) => execFileAsync(command, args, {
    timeout: 5000,
    encoding: 'utf8',
    windowsHide: true
});

function parseRegValue(stdout: string, name: string): string | undefined {
    const pattern = new RegExp(`\\b${name}\\s+REG_\\w+\\s+(.+)`, 'i');
    const match = stdout.match(pattern);
    return match?.[1]?.trim();
}

type WinHttpParse = Pick<WindowsProxyObservation, 'winHttpProxy' | 'winHttpBypass' | 'winHttpParseStatus'>;

/**
 * Extracts the raw hex payload of the `WinHttpSettings` REG_BINARY value from
 * `reg query` output. Returns undefined when the value is absent.
 */
export function extractWinHttpSettingsHex(regQueryStdout: string): string | undefined {
    const match = regQueryStdout.match(/\bWinHttpSettings\s+REG_BINARY\s+([0-9A-Fa-f]+)/i);
    return match?.[1];
}

/**
 * Parses the `WinHttpSettings` registry binary. This is the locale-independent
 * source of truth (unlike `netsh winhttp show proxy`, whose text is localized).
 *
 * Layout (little-endian): version(4) counter(4) flags(4)
 *   cchProxy(4) proxy[cchProxy] cchBypass(4) bypass[cchBypass]
 * flags 0x01 = direct access; the 0x02 bit is set when a named proxy is stored.
 * We derive proxy/bypass structurally from the length fields so we do not depend
 * on the exact flag encoding.
 *
 * Returns undefined when the payload is too short or internally inconsistent, so
 * the caller can fall back to best-effort netsh parsing.
 */
export function parseWinHttpRegistryBinary(hex: string): WinHttpParse | undefined {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length < 24 || clean.length % 2 !== 0) {
        // Need at least version + counter + flags (12 bytes) to be meaningful.
        return undefined;
    }
    const bytes = Buffer.from(clean, 'hex');
    const readDword = (offset: number): number | undefined =>
        offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : undefined;
    const readString = (offset: number, length: number): string | undefined => {
        if (length < 0 || offset + length > bytes.length) {
            return undefined;
        }
        // latin1 preserves every byte (ascii would strip the high bit); proxy
        // hosts are ASCII/punycode in practice, but fidelity is safer downstream.
        return bytes.toString('latin1', offset, offset + length);
    };

    let offset = 12; // skip version + counter + flags
    const cchProxy = readDword(offset);
    if (cchProxy === undefined) {
        return undefined;
    }
    offset += 4;
    let winHttpProxy: string | null = null;
    if (cchProxy > 0) {
        const proxy = readString(offset, cchProxy);
        if (proxy === undefined) {
            return undefined;
        }
        winHttpProxy = proxy;
        offset += cchProxy;
    }

    // A well-formed WinHttpSettings always carries the bypass-length DWORD (even
    // 0). Its absence means the payload is truncated, so reject it and let the
    // caller fall back to netsh rather than mislabel garbage as 'parsed'.
    const cchBypass = readDword(offset);
    if (cchBypass === undefined) {
        return undefined;
    }
    offset += 4;
    let winHttpBypass: string | null = null;
    if (cchBypass > 0) {
        const bypass = readString(offset, cchBypass);
        if (bypass === undefined) {
            return undefined;
        }
        winHttpBypass = bypass;
    }

    return {
        winHttpProxy: winHttpProxy && winHttpProxy.length > 0 ? winHttpProxy : null,
        winHttpBypass: winHttpBypass && winHttpBypass.length > 0 ? winHttpBypass : null,
        winHttpParseStatus: 'parsed'
    };
}

export function parseWinHttpShowProxy(output: string): Pick<WindowsProxyObservation, 'winHttpProxy' | 'winHttpBypass' | 'winHttpParseStatus'> {
    const normalized = output.replace(/\r/g, '');
    if (/Direct access|直接アクセス|プロキシ サーバーなし|プロキシなし/i.test(normalized)) {
        return { winHttpProxy: null, winHttpBypass: null, winHttpParseStatus: 'parsed' };
    }

    const proxyMatch = normalized.match(/(?:Proxy Server\(s\)|プロキシ サーバー)\s*:\s*(.+)/i);
    const bypassMatch = normalized.match(/(?:Bypass List|バイパス一覧|バイパス リスト)\s*:\s*(.+)/i);
    if (proxyMatch?.[1]) {
        return {
            winHttpProxy: proxyMatch[1].trim(),
            winHttpBypass: bypassMatch?.[1]?.trim(),
            winHttpParseStatus: 'parsed'
        };
    }

    return { winHttpProxy: undefined, winHttpBypass: undefined, winHttpParseStatus: 'parseUnavailable' };
}

export class WindowsProxyDiagnostics {
    private readonly redactor = new ProxySecretRedactor();

    constructor(
        private readonly runner: CommandRunner = DEFAULT_RUNNER,
        // Injectable so the win32-only control flow can be exercised on any CI OS.
        private readonly platform: NodeJS.Platform = process.platform
    ) {}

    async observe(): Promise<WindowsProxyObservation> {
        if (this.platform !== 'win32') {
            return { winHttpParseStatus: 'unavailable' };
        }

        const [winHttp, winInet] = await Promise.all([
            this.observeWinHttp(),
            this.observeWinInet()
        ]);

        return { ...winHttp, ...winInet };
    }

    toIssues(observation: WindowsProxyObservation): ProxyIssue[] {
        const issues: ProxyIssue[] = [];
        if (observation.winHttpParseStatus === 'parseUnavailable') {
            issues.push({
                id: 'windows.winhttp.parseUnavailable',
                fingerprint: 'windows.winhttp.parseUnavailable',
                category: 'capabilityUnavailable',
                impact: 'informational',
                targetId: 'windows.winhttp',
                targetHost: 'windowsHost',
                source: 'netsh',
                capability: 'parseUnavailable',
                autoAction: 'none',
                userAction: 'showDetails',
                evidence: { message: 'WinHTTP proxy output could not be parsed safely' }
            });
        }

        if (observation.winInetAutoConfigUrl) {
            issues.push({
                id: 'windows.wininet.pac',
                fingerprint: `windows.wininet.pac:${observation.winInetAutoConfigUrl}`,
                category: 'info',
                impact: 'informational',
                targetId: 'windows.wininet',
                targetHost: 'windowsHost',
                actualSanitized: this.redactor.redactString(observation.winInetAutoConfigUrl),
                source: 'registry',
                capability: 'readOnly',
                autoAction: 'none',
                userAction: 'showDetails',
                evidence: { autoConfigUrl: this.redactor.redactString(observation.winInetAutoConfigUrl) }
            });
        }

        return issues;
    }

    private async observeWinHttp(): Promise<Pick<WindowsProxyObservation, 'winHttpProxy' | 'winHttpBypass' | 'winHttpParseStatus'>> {
        // Primary: the locale-independent registry binary. netsh's text output is
        // localized, so on non-en/ja Windows it never parsed (issue #11).
        const fromRegistry = await this.observeWinHttpFromRegistry();
        if (fromRegistry) {
            return fromRegistry;
        }

        // Best-effort fallback: netsh text parsing (only reliable on en/ja).
        try {
            const { stdout } = await this.runner('netsh', ['winhttp', 'show', 'proxy']);
            return parseWinHttpShowProxy(stdout);
        } catch {
            return { winHttpParseStatus: 'unavailable' };
        }
    }

    private async observeWinHttpFromRegistry(): Promise<Pick<WindowsProxyObservation, 'winHttpProxy' | 'winHttpBypass' | 'winHttpParseStatus'> | undefined> {
        try {
            const { stdout } = await this.runner('reg', [
                'query',
                'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections',
                '/v',
                'WinHttpSettings'
            ]);
            const hex = extractWinHttpSettingsHex(stdout);
            if (!hex) {
                return undefined;
            }
            return parseWinHttpRegistryBinary(hex);
        } catch {
            return undefined;
        }
    }

    private async observeWinInet(): Promise<Partial<WindowsProxyObservation>> {
        try {
            const { stdout } = await this.runner('reg', [
                'query',
                'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                '/v',
                '*'
            ]);
            const proxyEnable = parseRegValue(stdout, 'ProxyEnable');
            return {
                winInetProxyEnable: proxyEnable ? proxyEnable.endsWith('1') : undefined,
                winInetProxyServer: parseRegValue(stdout, 'ProxyServer'),
                winInetAutoConfigUrl: parseRegValue(stdout, 'AutoConfigURL'),
                winInetProxyOverride: parseRegValue(stdout, 'ProxyOverride')
            };
        } catch {
            return {};
        }
    }
}
