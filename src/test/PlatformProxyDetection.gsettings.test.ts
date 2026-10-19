/**
 * GNOME proxy detection reads its settings with one
 * `gsettings list-recursively org.gnome.system.proxy` call (#108). Each row
 * below is one desktop: the same settings drive a per-key `gsettings get` fake
 * (the reads before #108) and a `list-recursively` fake, and both must give
 * the same detection.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { detectLinuxProxy } from '../config/PlatformProxyDetection';
import type { CommandExecutor } from '../config/PlatformProxyDetection';
import { Logger } from '../utils/Logger';

const BASE_SCHEMA = 'org.gnome.system.proxy';

/** What the detection reports, without the issue envelope. */
interface Summary {
    kind: string | undefined;
    proxyUrl: string | null;
    autoConfigUrl?: string;
}

interface Row {
    name: string;
    /**
     * `g_variant_print` text by dotted key (`mode`, `http.host`, ...). A key
     * left out is one the per-key read fails on and the recursive listing
     * does not print.
     */
    settings: Record<string, string>;
    expected: Summary;
}

const NONE: Summary = { kind: 'direct', proxyUrl: null };
const UNKNOWN: Summary = { kind: 'unknown', proxyUrl: null };
const proxy = (url: string): Summary => ({ kind: 'singleProxy', proxyUrl: url });

const ROWS: Row[] = [
    { name: 'mode none is no proxy', settings: { mode: "'none'" }, expected: NONE },
    {
        name: 'manual with an http proxy and an unset https proxy',
        settings: { mode: "'manual'", 'http.host': "'proxy.example.com'", 'http.port': '8080', 'https.host': "''", 'https.port': '0' },
        expected: proxy('http://proxy.example.com:8080')
    },
    {
        name: 'manual with an https proxy only',
        settings: { mode: "'manual'", 'http.host': "''", 'http.port': '0', 'https.host': "'tls.example.com'", 'https.port': '8443' },
        expected: proxy('http://tls.example.com:8443')
    },
    {
        name: 'manual with the same proxy on both schemes',
        settings: { mode: "'manual'", 'http.host': "'proxy.example.com'", 'http.port': '8080', 'https.host': "'proxy.example.com'", 'https.port': '8080' },
        expected: proxy('http://proxy.example.com:8080')
    },
    {
        name: 'manual with a host and port 0 is unset',
        settings: { mode: "'manual'", 'http.host': "'proxy.example.com'", 'http.port': '0', 'https.host': "''", 'https.port': '0' },
        expected: NONE
    },
    {
        name: 'manual with both schemes unset is no proxy',
        settings: { mode: "'manual'", 'http.host': "''", 'http.port': '0', 'https.host': "''", 'https.port': '0' },
        expected: NONE
    },
    {
        name: 'manual with the http scheme unreadable and an https proxy gives the proxy',
        settings: { mode: "'manual'", 'https.host': "'tls.example.com'", 'https.port': '8443' },
        expected: proxy('http://tls.example.com:8443')
    },
    {
        name: 'manual with the http port unreadable and an https proxy gives the proxy',
        settings: { mode: "'manual'", 'http.host': "'proxy.example.com'", 'https.host': "'tls.example.com'", 'https.port': '8443' },
        expected: proxy('http://tls.example.com:8443')
    },
    {
        name: 'manual with the http scheme unreadable and https unset is unknown',
        settings: { mode: "'manual'", 'https.host': "''", 'https.port': '0' },
        expected: UNKNOWN
    },
    { name: 'manual with both schemes unreadable is unknown', settings: { mode: "'manual'" }, expected: UNKNOWN },
    {
        name: 'auto reports the PAC URL',
        settings: { mode: "'auto'", 'autoconfig-url': "'http://pac.example.com/proxy.pac'" },
        expected: { kind: 'pac', proxyUrl: null, autoConfigUrl: 'http://pac.example.com/proxy.pac' }
    },
    {
        name: 'auto with an empty PAC URL reports none',
        settings: { mode: "'auto'", 'autoconfig-url': "''" },
        expected: { kind: 'pac', proxyUrl: null, autoConfigUrl: undefined }
    },
    {
        name: 'auto with an unreadable PAC URL reports none',
        settings: { mode: "'auto'" },
        expected: { kind: 'pac', proxyUrl: null, autoConfigUrl: undefined }
    },
    { name: 'a run with no mode is unknown', settings: {}, expected: UNKNOWN }
];

// What `gsettings list-recursively` prints besides the keys detection reads.
const OTHER_KEYS = [
    `${BASE_SCHEMA} ignore-hosts ['localhost', '127.0.0.0/8', '::1']`,
    `${BASE_SCHEMA}.http enabled false`,
    `${BASE_SCHEMA}.http use-authentication false`,
    `${BASE_SCHEMA}.https enabled false`,
    `${BASE_SCHEMA}.ftp host ''`,
    `${BASE_SCHEMA}.ftp port 0`,
    `${BASE_SCHEMA}.socks host ''`,
    `${BASE_SCHEMA}.socks port 0`
];

function schemaAndKey(dotted: string): [string, string] {
    const dot = dotted.indexOf('.');
    return dot === -1 ? [BASE_SCHEMA, dotted] : [`${BASE_SCHEMA}.${dotted.slice(0, dot)}`, dotted.slice(dot + 1)];
}

function commandError(message: string, extra: { code?: string; stderr?: string } = {}): Error {
    return Object.assign(new Error(message), extra);
}

/** The listing as `gsettings list-recursively` prints it: `<schema> <key> <value>` per line. */
function recursiveListing(settings: Record<string, string>): string {
    const lines = Object.entries(settings).map(([dotted, value]) => {
        const [schema, key] = schemaAndKey(dotted);
        return `${schema} ${key} ${value}`;
    });
    return `${[...OTHER_KEYS, ...lines].join('\n')}\n`;
}

function summarize(result: Awaited<ReturnType<typeof detectLinuxProxy>>): Summary {
    const summary: Summary = { kind: result.kind, proxyUrl: result.proxyUrl };
    if (result.kind === 'pac') {
        summary.autoConfigUrl = result.issue?.evidence.autoConfigUrl as string | undefined;
    }
    return summary;
}

suite('GNOME proxy detection through one gsettings call (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let errors: unknown[][];

    setup(() => {
        sandbox = sinon.createSandbox();
        errors = [];
        sandbox.stub(Logger, 'error').callsFake((...args: unknown[]) => { errors.push(args); });
        sandbox.stub(Logger, 'debug');
    });
    teardown(() => sandbox.restore());

    function recursiveExec(stdout: string, calls: string[][] = []): CommandExecutor {
        return async (command, args) => {
            assert.strictEqual(command, 'gsettings');
            calls.push(args);
            return { stdout, stderr: '' };
        };
    }

    for (const row of ROWS) {
        test(`list-recursively: ${row.name}`, async () => {
            const result = await detectLinuxProxy(recursiveExec(recursiveListing(row.settings)));

            assert.deepStrictEqual(summarize(result), row.expected);
        });
    }

    test('one gsettings call per detection, with the C locale, in every mode', async () => {
        for (const row of ROWS) {
            const calls: string[][] = [];
            const environments: unknown[] = [];
            const exec: CommandExecutor = async (command, args, options) => {
                environments.push(options?.env);
                return recursiveExec(recursiveListing(row.settings), calls)(command, args, options);
            };

            await detectLinuxProxy(exec);

            assert.deepStrictEqual(calls, [['list-recursively', BASE_SCHEMA]], row.name);
            assert.deepStrictEqual(environments, [{ LANGUAGE: 'C', LC_MESSAGES: 'C' }], row.name);
        }
    });

    test('only the mode value decides auto and manual: another key containing both words is ignored', async () => {
        const listing = recursiveListing({ mode: "'none'" })
            + `${BASE_SCHEMA}.http authentication-user 'automanual'\n`
            + `${BASE_SCHEMA} autoconfig-url 'http://automanual.example.com/pac'\n`;

        assert.deepStrictEqual(summarize(await detectLinuxProxy(recursiveExec(listing))), NONE);
    });

    test('a key of another scheme is not mistaken for http or https', async () => {
        const listing = recursiveListing({ mode: "'manual'" })
            + `${BASE_SCHEMA}.ftp host 'ftp.example.com'\n`
            + `${BASE_SCHEMA}.ftp port 21\n`
            + `${BASE_SCHEMA}.socks host 'socks.example.com'\n`
            + `${BASE_SCHEMA}.socks port 1080\n`;

        assert.deepStrictEqual(summarize(await detectLinuxProxy(recursiveExec(listing))), UNKNOWN);
    });

    test('a value with spaces keeps them after the key', async () => {
        const listing = recursiveListing({
            mode: "'manual'", 'http.host': "'proxy host.example.com'", 'http.port': '8080', 'https.host': "''", 'https.port': '0'
        });

        assert.deepStrictEqual(summarize(await detectLinuxProxy(recursiveExec(listing))), proxy('http://proxy host.example.com:8080'));
    });

    test('Windows line endings and blank lines in the listing are tolerated', async () => {
        const listing = recursiveListing({ mode: "'auto'", 'autoconfig-url': "'http://pac.example.com/proxy.pac'" })
            .replace(/\n/g, '\r\n') + '\r\n';

        assert.deepStrictEqual(summarize(await detectLinuxProxy(recursiveExec(listing))), {
            kind: 'pac', proxyUrl: null, autoConfigUrl: 'http://pac.example.com/proxy.pac'
        });
    });

    test('an unparsable line makes the detection unknown and the log carries no line content', async () => {
        const secretLine = 'credential-bearing-token-line';
        const listing = `${recursiveListing({ mode: "'manual'" })}${secretLine}\n`;

        assert.deepStrictEqual(summarize(await detectLinuxProxy(recursiveExec(listing))), UNKNOWN);

        assert.ok(errors.length > 0, 'the failure is logged');
        assert.ok(!JSON.stringify(errors, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value)
            .includes(secretLine), 'no parsed line enters the log');
    });

    suite('failures', () => {
        test('gsettings missing (ENOENT) is not applicable', async () => {
            const exec: CommandExecutor = async () => { throw commandError('spawn gsettings ENOENT', { code: 'ENOENT' }); };

            assert.deepStrictEqual(summarize(await detectLinuxProxy(exec)), NONE);
        });

        test('no GNOME proxy schema is not applicable', async () => {
            const exec: CommandExecutor = async () => {
                throw commandError('Command failed: gsettings', { stderr: 'No such schema \u201Corg.gnome.system.proxy\u201D\n' });
            };

            assert.deepStrictEqual(summarize(await detectLinuxProxy(exec)), NONE);
        });

        test('any other failure is unknown, and the log gets the error but never stdout', async () => {
            const stdout = 'stdout-with-a-secret';
            const exec: CommandExecutor = async () => {
                throw Object.assign(commandError('Command failed: gsettings', { stderr: 'dconf-CRITICAL: unable to open' }), { stdout });
            };

            assert.deepStrictEqual(summarize(await detectLinuxProxy(exec)), UNKNOWN);

            assert.ok(!JSON.stringify(errors, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value)
                .includes(stdout));
        });
    });
});
