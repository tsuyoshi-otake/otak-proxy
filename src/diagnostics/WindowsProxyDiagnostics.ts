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

    constructor(private readonly runner: CommandRunner = DEFAULT_RUNNER) {}

    async observe(): Promise<WindowsProxyObservation> {
        if (process.platform !== 'win32') {
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
        try {
            const { stdout } = await this.runner('netsh', ['winhttp', 'show', 'proxy']);
            return parseWinHttpShowProxy(stdout);
        } catch {
            return { winHttpParseStatus: 'unavailable' };
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
