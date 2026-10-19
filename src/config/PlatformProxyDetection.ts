import { Logger } from '../utils/Logger';
import { buildDetectedProxyValue, normalizeProxyEndpoint, unknownDetection } from './DetectedProxyValue';
import type { ProxyDetectionWithSource } from './SystemProxyDetector';
import { createUnsupportedAutoConfigIssue } from '../diagnostics/unsupportedAutoConfig';
import { parseRegValue, dwordIsEnabled } from '../utils/WindowsRegistryValue';

/** `env` is merged over the inherited environment by the real executor. */
export interface CommandOptions {
    env?: Record<string, string>;
}

export type CommandExecutor = (
    command: string,
    args: string[],
    options?: CommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface WindowsProxyServerParse {
    http?: string;
    https?: string;
}

const FALLBACK_MACOS_SERVICES = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

/**
 * GLib translates its `gsettings` error text, so the "no proxy schema" check
 * needs the untranslated message. LANGUAGE=C wins over any user locale in
 * glibc's gettext (including an LC_ALL); LC_MESSAGES=C covers a gettext without
 * LANGUAGE support. LC_CTYPE is left alone so value output does not change.
 */
const GSETTINGS_OPTIONS: CommandOptions = { env: { LANGUAGE: 'C', LC_MESSAGES: 'C' } };
/**
 * "No such schema": the GNOME proxy schema is not installed. "No schemas
 * installed": the schema registry itself is empty (no compiled schemas at
 * all). Both mean there is no GNOME proxy setting to read, not a failed query.
 */
const GSETTINGS_NO_SCHEMA_PATTERN = /No such schema|No schemas installed/i;

function noneDetection(source: ProxyDetectionWithSource['source'] = null): ProxyDetectionWithSource {
    return { proxyUrl: null, source, kind: 'direct', capability: 'supported' };
}

export async function detectPlatformProxyWithSource(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        switch (process.platform) {
            case 'win32':
                return await detectWindowsProxy(exec);
            case 'darwin':
                return await detectMacOSProxy(exec);
            case 'linux':
                return await detectLinuxProxy(exec);
            default:
                Logger.warn(`Unsupported platform for proxy detection: ${process.platform}`);
                return { proxyUrl: null, source: null };
        }
    } catch (error) {
        Logger.error(`Platform-specific proxy detection failed for ${process.platform}:`, error);
        return unknownDetection();
    }
}

const WINDOWS_INTERNET_SETTINGS_KEY =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export async function detectWindowsProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    try {
        const { stdout } = await exec('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY]);
        const proxyEnable = dwordIsEnabled(parseRegValue(stdout, 'ProxyEnable'));
        const proxyServer = parseRegValue(stdout, 'ProxyServer');
        const autoConfigUrl = parseRegValue(stdout, 'AutoConfigURL');
        const autoDetect = dwordIsEnabled(parseRegValue(stdout, 'AutoDetect'));
        const bypass = parseRegValue(stdout, 'ProxyOverride');

        if (proxyEnable && proxyServer) {
            const parsed = parseWindowsProxyServer(proxyServer);
            return buildDetectedProxyValue({
                http: parsed.http,
                https: parsed.https,
                bypass,
                source: 'windows'
            });
        }

        if (autoConfigUrl) {
            return {
                proxyUrl: null,
                source: 'windows',
                kind: 'pac',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'windows.wininet.pac',
                    targetId: 'windows.wininet',
                    targetHost: 'windowsHost',
                    source: 'registry',
                    kind: 'pac',
                    autoConfigUrl
                })
            };
        }

        if (autoDetect) {
            return {
                proxyUrl: null,
                source: 'windows',
                kind: 'wpad',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'windows.wininet.wpad',
                    targetId: 'windows.wininet',
                    targetHost: 'windowsHost',
                    source: 'registry',
                    kind: 'wpad',
                    evidence: { observation: 'registry AutoDetect' }
                })
            };
        }

        return noneDetection();
    } catch (error) {
        if (isMissingRegistryKey(error)) {
            // No Internet Settings key: nothing configures a WinINet proxy.
            return noneDetection();
        }
        Logger.error('Windows registry query failed:', error);
        return unknownDetection();
    }
}

/**
 * `reg query` on an absent key exits 1 with this text. It is localized, so on
 * a non-English Windows a missing key stays `unknown` (the safe side).
 */
const REG_MISSING_KEY_PATTERN = /unable to find the specified registry key/i;

function isMissingRegistryKey(error: unknown): boolean {
    const { message, stderr } = (error ?? {}) as { message?: unknown; stderr?: unknown };
    return [message, stderr].some(text => typeof text === 'string' && REG_MISSING_KEY_PATTERN.test(text));
}

/**
 * `ProxyServer` is either one endpoint (`host:port`) or `scheme=endpoint`
 * parts; parts are separated by `;` or whitespace, and a trailing separator
 * is harmless. Several bare endpoints are not defined: the first one is used.
 */
export function parseWindowsProxyServer(proxyValue: string): WindowsProxyServerParse {
    const parts = proxyValue.split(/[;\s]+/).filter(part => part.length > 0);
    if (!parts.some(part => part.includes('='))) {
        const url = normalizeProxyEndpoint(parts[0]);
        return url ? { http: url, https: url } : {};
    }

    const parsed: WindowsProxyServerParse = {};
    for (const part of parts) {
        const separator = part.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const key = part.slice(0, separator).trim().toLowerCase();
        const url = normalizeProxyEndpoint(part.slice(separator + 1));
        if (!url) {
            continue;
        }
        if (key === 'http') {
            parsed.http = url;
        } else if (key === 'https') {
            parsed.https = url;
        }
    }
    return parsed;
}

export function parseMacOSNetworkServices(stdout: string): string[] {
    const services: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        if (/asterisk/i.test(line) && /disabled/i.test(line)) {
            continue;
        }
        if (line.startsWith('*')) {
            continue;
        }
        services.push(line);
    }
    return services;
}

interface MacNetworkServices {
    services: string[];
    /** The list command failed, so the names are guesses. */
    usedFallback: boolean;
}

async function listMacOSNetworkServices(exec: CommandExecutor): Promise<MacNetworkServices> {
    try {
        const { stdout } = await exec('networksetup', ['-listallnetworkservices']);
        // A successful list with no enabled service is an answer: there is no
        // service that could carry a proxy, so nothing is guessed (#108).
        return { services: parseMacOSNetworkServices(stdout), usedFallback: false };
    } catch (error) {
        Logger.debug('networksetup -listallnetworkservices failed; falling back to well-known names:', error);
    }
    return { services: [...FALLBACK_MACOS_SERVICES], usedFallback: true };
}

/** A query that failed (exec rejected) is told apart from one that answered "none". */
type MacQueryResult = { failed: true } | { failed: false; value?: string };

interface MacQueryTally {
    made: number;
    failed: number;
}

/**
 * Manual proxy (first service in list order) > unknown > first PAC URL > direct.
 * With a real service list, a failed query on any listed service makes the
 * result unknown: that service may carry a manual proxy, which outranks a PAC,
 * and reporting the PAC would move Auto to the fallback. With the guessed
 * fallback names a failed query only means the name does not exist, so it is
 * unknown only when every query failed.
 */
export async function detectMacOSProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    const { services, usedFallback } = await listMacOSNetworkServices(exec);
    const tally: MacQueryTally = { made: 0, failed: 0 };
    let firstPacUrl: string | undefined;

    for (const iface of services) {
        const http = countMacQuery(tally, await readMacNetworkProxy(exec, '-getwebproxy', iface));
        const https = countMacQuery(tally, await readMacNetworkProxy(exec, '-getsecurewebproxy', iface));
        if (http || https) {
            return buildDetectedProxyValue({
                http,
                https,
                source: 'macos'
            });
        }
        if (!firstPacUrl) {
            firstPacUrl = countMacQuery(tally, await readMacAutoProxyUrl(exec, iface));
        }
    }

    if (usedFallback ? tally.failed === tally.made : tally.failed > 0) {
        Logger.error('networksetup queries failed; the macOS proxy settings are unknown');
        return unknownDetection();
    }

    if (firstPacUrl) {
        return {
            proxyUrl: null,
            source: 'macos',
            kind: 'pac',
            capability: 'unsupported',
            issue: createUnsupportedAutoConfigIssue({
                id: 'macos.autoproxy.pac',
                targetId: 'macos.networksetup',
                targetHost: 'unavailable',
                source: 'networksetup',
                kind: 'pac',
                autoConfigUrl: firstPacUrl
            })
        };
    }

    return noneDetection();
}

function countMacQuery(tally: MacQueryTally, result: MacQueryResult): string | undefined {
    tally.made++;
    if (result.failed) {
        tally.failed++;
        return undefined;
    }
    return result.value;
}

async function readMacNetworkProxy(
    exec: CommandExecutor,
    flag: '-getwebproxy' | '-getsecurewebproxy',
    iface: string
): Promise<MacQueryResult> {
    try {
        const { stdout } = await exec('networksetup', [flag, iface]);
        const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
        const serverMatch = stdout.match(/Server:\s*(.+)/);
        const portMatch = stdout.match(/Port:\s*(\d+)/);

        if (enabledMatch && enabledMatch[1] === 'Yes' && serverMatch && portMatch) {
            return { failed: false, value: `http://${serverMatch[1].trim()}:${portMatch[1].trim()}` };
        }
        return { failed: false };
    } catch (error) {
        Logger.debug(`Interface ${iface} ${flag} not available or failed:`, error);
        return { failed: true };
    }
}

async function readMacAutoProxyUrl(exec: CommandExecutor, iface: string): Promise<MacQueryResult> {
    try {
        const { stdout } = await exec('networksetup', ['-getautoproxyurl', iface]);
        const enabledMatch = stdout.match(/Enabled:\s*(\w+)/);
        const urlMatch = stdout.match(/URL:\s*(.+)/);
        const url = urlMatch?.[1]?.trim();
        if (enabledMatch?.[1] === 'Yes' && url && url !== '(null)') {
            return { failed: false, value: url };
        }
        return { failed: false };
    } catch (error) {
        Logger.debug(`Interface ${iface} -getautoproxyurl not available or failed:`, error);
        return { failed: true };
    }
}

/** gsettings missing, or no GNOME proxy schema: this desktop has no such setting. */
function isGsettingsNotApplicable(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const { code, stderr, message } = error as { code?: unknown; stderr?: unknown; message?: unknown };
    return code === 'ENOENT'
        || GSETTINGS_NO_SCHEMA_PATTERN.test(String(stderr ?? ''))
        || GSETTINGS_NO_SCHEMA_PATTERN.test(String(message ?? ''));
}

/** The GNOME proxy schema and its children (`.http`, `.https`, ...) in one listing. */
const GNOME_PROXY_SCHEMA = 'org.gnome.system.proxy';

/** The settings detection reads, by dotted key; every other key of the listing is ignored. */
const GNOME_PROXY_KEYS: ReadonlySet<string> = new Set([
    'mode', 'autoconfig-url', 'http.host', 'http.port', 'https.host', 'https.port'
]);

/**
 * `gsettings list-recursively` prints `<schema> <key> <value>` per key, with the
 * value as `g_variant_print` shows it, which is the text `gsettings get` prints
 * for that key. A child schema prints its own id, so `http.host` is the line
 * `org.gnome.system.proxy.http host '...'`. A line that does not have that shape
 * fails the parse with a fixed message: a line may carry a credential, so none
 * of its content enters the error.
 */
function parseGnomeProxySettings(stdout: string): Map<string, string> {
    const settings = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        const keyStart = line.indexOf(' ') + 1;
        const valueStart = keyStart === 0 ? -1 : line.indexOf(' ', keyStart) + 1;
        if (valueStart <= 0) {
            throw new Error('Unexpected gsettings list-recursively output');
        }
        const schema = line.slice(0, keyStart - 1);
        const key = line.slice(keyStart, valueStart - 1);
        const dotted = schema === GNOME_PROXY_SCHEMA
            ? key
            : schema.startsWith(`${GNOME_PROXY_SCHEMA}.`) ? `${schema.slice(GNOME_PROXY_SCHEMA.length + 1)}.${key}` : undefined;
        if (dotted && GNOME_PROXY_KEYS.has(dotted)) {
            settings.set(dotted, line.slice(valueStart));
        }
    }
    return settings;
}

export async function detectLinuxProxy(exec: CommandExecutor): Promise<ProxyDetectionWithSource> {
    let stdout: string;
    try {
        ({ stdout } = await exec('gsettings', ['list-recursively', GNOME_PROXY_SCHEMA], GSETTINGS_OPTIONS));
    } catch (error) {
        if (isGsettingsNotApplicable(error)) {
            Logger.debug('gsettings or the GNOME proxy schema is not available; no GNOME proxy setting:', error);
            return noneDetection();
        }
        Logger.error('Linux gsettings query failed:', error);
        return unknownDetection();
    }

    try {
        const settings = parseGnomeProxySettings(stdout);
        // Only the mode value decides auto and manual: another key may contain either word.
        const mode = settings.get('mode');
        if (mode === undefined) {
            throw new Error('The gsettings listing has no proxy mode');
        }

        if (mode.includes('auto')) {
            const autoConfigUrl = (settings.get('autoconfig-url') ?? '').replace(/'/g, '').trim() || undefined;
            return {
                proxyUrl: null,
                source: 'linux',
                kind: 'pac',
                capability: 'unsupported',
                issue: createUnsupportedAutoConfigIssue({
                    id: 'linux.gnome.auto',
                    targetId: 'linux.gsettings',
                    targetHost: 'unavailable',
                    source: 'gsettings',
                    kind: 'pac',
                    autoConfigUrl
                })
            };
        }

        if (!mode.includes('manual')) {
            return noneDetection();
        }

        const http = readGnomeSchemeProxy(settings, 'http');
        const https = readGnomeSchemeProxy(settings, 'https');
        // One scheme unreadable still lets the other one's proxy through; with
        // no proxy found, an unreadable scheme leaves "no proxy" unproven.
        if (!http.url && !https.url && (http.failed || https.failed)) {
            return unknownDetection();
        }
        return buildDetectedProxyValue({
            http: http.url,
            https: https.url,
            source: 'linux'
        });
    } catch (error) {
        Logger.error('Linux gsettings query failed:', error);
        return unknownDetection();
    }
}

/** A scheme whose host or port is missing from the listing counts as unreadable. */
function readGnomeSchemeProxy(
    settings: ReadonlyMap<string, string>,
    scheme: 'http' | 'https'
): { url?: string; failed: boolean } {
    const host = settings.get(`${scheme}.host`);
    const port = settings.get(`${scheme}.port`);
    if (host === undefined || port === undefined) {
        Logger.debug(`GNOME ${scheme} proxy host or port is missing from the gsettings listing`);
        return { failed: true };
    }
    const cleanHost = host.replace(/'/g, '').trim();
    const cleanPort = port.trim();
    return { url: cleanHost && cleanPort !== '0' ? `http://${cleanHost}:${cleanPort}` : undefined, failed: false };
}
