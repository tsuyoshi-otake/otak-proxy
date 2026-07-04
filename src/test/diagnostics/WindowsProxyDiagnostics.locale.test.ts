import * as assert from 'assert';
import {
    CommandRunner,
    WindowsProxyDiagnostics,
    parseWinHttpRegistryBinary
} from '../../diagnostics/WindowsProxyDiagnostics';

/**
 * Regression for the v3 post-release review finding (#11): netsh text parsing
 * only understood English/Japanese, so on any other-locale Windows the WinHTTP
 * observation was always `parseUnavailable` and proxy/bypass were never read.
 *
 * The fix reads the locale-independent registry binary (WinHttpSettings) as the
 * primary source and demotes netsh text parsing to a best-effort fallback.
 */

/** Builds a WinHttpSettings REG_BINARY payload exactly as Windows stores it. */
function buildWinHttpBinary(proxy: string | null, bypass: string | null): string {
    const dword = (n: number): Buffer => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n, 0);
        return b;
    };
    const proxyBuf = Buffer.from(proxy ?? '', 'ascii');
    const bypassBuf = Buffer.from(bypass ?? '', 'ascii');
    return Buffer.concat([
        dword(0x28),                       // version
        dword(0),                          // counter
        dword(proxy ? 0x03 : 0x01),        // flags: 0x01 direct, includes 0x02 when a proxy is set
        dword(proxyBuf.length),
        proxyBuf,
        dword(bypassBuf.length),
        bypassBuf
    ]).toString('hex');
}

/** Mimics `reg query` textual output for a REG_BINARY value. */
function regQueryOutput(valueName: string, hex: string): string {
    return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections\r\n    ${valueName}    REG_BINARY    ${hex}\r\n\r\n`;
}

suite('WindowsProxyDiagnostics registry binary parsing (locale-independent)', () => {
    test('parses the direct-access binary (flags=0x01, no proxy string)', () => {
        // Exactly the bytes observed via `netsh winhttp reset proxy` on a real machine.
        const hex = '2800000000000000010000000000000000000000';
        const result = parseWinHttpRegistryBinary(hex);
        assert.ok(result, 'direct-access binary must parse');
        assert.strictEqual(result?.winHttpParseStatus, 'parsed');
        assert.strictEqual(result?.winHttpProxy, null);
        assert.strictEqual(result?.winHttpBypass, null);
    });

    test('parses a named-proxy binary with proxy and bypass strings', () => {
        const hex = buildWinHttpBinary('proxy.example.com:8080', '<local>');
        const result = parseWinHttpRegistryBinary(hex);
        assert.ok(result, 'named-proxy binary must parse');
        assert.strictEqual(result?.winHttpParseStatus, 'parsed');
        assert.strictEqual(result?.winHttpProxy, 'proxy.example.com:8080');
        assert.strictEqual(result?.winHttpBypass, '<local>');
    });

    test('returns undefined for malformed / truncated binary', () => {
        assert.strictEqual(parseWinHttpRegistryBinary('2800'), undefined);
        assert.strictEqual(parseWinHttpRegistryBinary(''), undefined);
        // Claims a 200-byte proxy string that the buffer does not contain.
        const dword = (n: number): string => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(n, 0);
            return b.toString('hex');
        };
        const lying = dword(0x28) + dword(0) + dword(0x03) + dword(200) + '41';
        assert.strictEqual(parseWinHttpRegistryBinary(lying), undefined);
    });

    test('returns undefined when the required bypass-length DWORD is missing', () => {
        // A real WinHttpSettings always carries the cchBypass DWORD (even 0).
        // version + counter + flags + cchProxy(0) but NO cchBypass -> truncated.
        const dword = (n: number): string => {
            const b = Buffer.alloc(4);
            b.writeUInt32LE(n, 0);
            return b.toString('hex');
        };
        const truncated = dword(0x28) + dword(0) + dword(0x01) + dword(0); // 16 bytes, no cchBypass
        assert.strictEqual(parseWinHttpRegistryBinary(truncated), undefined);

        // Same, but with a proxy string present and the bypass DWORD cut off.
        const proxy = Buffer.from('h:1', 'ascii');
        const truncatedAfterProxy =
            dword(0x28) + dword(0) + dword(0x03) + dword(proxy.length) + proxy.toString('hex');
        assert.strictEqual(parseWinHttpRegistryBinary(truncatedAfterProxy), undefined);
    });
});

suite('WindowsProxyDiagnostics.observe locale independence', () => {
    test('reads WinHTTP proxy from the registry even when netsh output is a foreign locale', async function () {
        const hex = buildWinHttpBinary('proxy.example.com:8080', '<local>');
        const runner: CommandRunner = async (command, args) => {
            if (command === 'reg' && args.includes('WinHttpSettings')) {
                return { stdout: regQueryOutput('WinHttpSettings', hex), stderr: '' };
            }
            if (command === 'reg') {
                // WinINet Internet Settings query — return an empty-ish key.
                return { stdout: 'HKEY_CURRENT_USER\\...\\Internet Settings\r\n', stderr: '' };
            }
            if (command === 'netsh') {
                // German-localized netsh output: matches NEITHER the English nor the
                // Japanese regex, which is exactly what broke on other locales.
                return {
                    stdout: 'Aktuelle WinHTTP-Proxyeinstellungen:\r\n\r\n    Proxyserver:  proxy.example.com:8080\r\n    Verbindungen, die die Proxyliste umgehen:  <local>\r\n',
                    stderr: ''
                };
            }
            throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        };

        // Force the win32 code path so this runs on any CI OS (Linux/macOS too).
        const diagnostics = new WindowsProxyDiagnostics(runner, 'win32');
        const observation = await diagnostics.observe();

        assert.strictEqual(observation.winHttpParseStatus, 'parsed', 'registry read must yield parsed, not parseUnavailable');
        assert.strictEqual(observation.winHttpProxy, 'proxy.example.com:8080');
        assert.strictEqual(observation.winHttpBypass, '<local>');

        // And no informational parseUnavailable issue should be emitted.
        const issues = diagnostics.toIssues(observation);
        assert.ok(
            !issues.some(i => i.id === 'windows.winhttp.parseUnavailable'),
            'parseUnavailable issue must not fire when the registry gave a definitive answer'
        );
    });

    test('falls back to netsh text parsing when the registry read fails', async function () {
        const runner: CommandRunner = async (command, args) => {
            if (command === 'reg' && args.includes('WinHttpSettings')) {
                throw new Error('registry unavailable');
            }
            if (command === 'reg') {
                return { stdout: '', stderr: '' };
            }
            if (command === 'netsh') {
                return {
                    stdout: 'Current WinHTTP proxy settings:\r\n\r\n    Proxy Server(s) :  proxy.example.com:8080\r\n    Bypass List     :  <local>\r\n',
                    stderr: ''
                };
            }
            throw new Error(`unexpected command: ${command}`);
        };

        const diagnostics = new WindowsProxyDiagnostics(runner, 'win32');
        const observation = await diagnostics.observe();
        assert.strictEqual(observation.winHttpParseStatus, 'parsed');
        assert.strictEqual(observation.winHttpProxy, 'proxy.example.com:8080');
    });
});
