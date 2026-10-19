import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    parseRegQueryEnvironment,
    PROXY_ENVIRONMENT_NAMES,
    ProxyEnvironmentName,
    readWindowsProxyEnvironment,
    SavedProxyEnvironment,
    WindowsProxyEnvironmentMonitor,
    WindowsProxyEnvironmentSnapshot
} from '../monitoring/WindowsProxyEnvironment';

function snapshot(): WindowsProxyEnvironmentSnapshot {
    const empty = { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null };
    return { user: { ...empty }, machine: { ...empty } };
}

const USER_HEADER = 'HKEY_CURRENT_USER\\Environment';
const MACHINE_HEADER = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const NONE: SavedProxyEnvironment = { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null };

/** `reg query <key>` output: CRLF lines, a blank line first and last. */
function regQueryOutput(header: string, lines: string[]): string {
    return `\r\n${header}\r\n${lines.join('\r\n')}\r\n\r\n`;
}

/** One value line: four spaces around the type, and after the name. */
function valueLine(name: string, type: string, text?: string): string {
    return text === undefined ? `    ${name}    ${type}` : `    ${name}    ${type}    ${text}`;
}

function parseUser(lines: string[], environment: NodeJS.ProcessEnv = {}): SavedProxyEnvironment {
    return parseRegQueryEnvironment(regQueryOutput(USER_HEADER, lines), USER_HEADER, environment);
}

suite('WindowsProxyEnvironment', () => {
    let clock: sinon.SinonFakeTimers;
    let saved: WindowsProxyEnvironmentSnapshot;
    let environment: NodeJS.ProcessEnv;
    let notices: ProxyEnvironmentName[][];
    let monitor: WindowsProxyEnvironmentMonitor;
    let read: sinon.SinonStub;

    setup(() => {
        clock = sinon.useFakeTimers();
        saved = snapshot();
        environment = {};
        notices = [];
        read = sinon.stub().callsFake(async () => saved);
        monitor = new WindowsProxyEnvironmentMonitor({
            read, environment, notify: names => notices.push(names), random: () => 0
        });
    });
    teardown(() => { monitor.dispose(); clock.restore(); });

    suite('parseRegQueryEnvironment', () => {
        const nonAscii = String.fromCodePoint(0x3041);
        const replacement = String.fromCodePoint(0xFFFD);
        const astral = String.fromCodePoint(0x1F600);

        test('reads REG_SZ values, with the names matched case-insensitively', () => {
            assert.deepStrictEqual(
                parseUser([
                    valueLine('HTTP_PROXY', 'REG_SZ', 'http://proxy.example:8080'),
                    valueLine('https_proxy', 'REG_SZ', 'http://alice:s%40cret@secure.example:8443'),
                    valueLine('No_Proxy', 'REG_SZ', 'localhost, *.example')
                ]),
                {
                    HTTP_PROXY: 'http://proxy.example:8080',
                    HTTPS_PROXY: 'http://alice:s%40cret@secure.example:8443',
                    ALL_PROXY: null,
                    NO_PROXY: 'localhost, *.example'
                }
            );
        });

        test('a missing variable is null and an empty one is the empty string, with or without the last separator', () => {
            assert.deepStrictEqual(parseUser([valueLine('PATH', 'REG_EXPAND_SZ', 'C:\\bin')]), NONE);
            for (const line of [valueLine('HTTP_PROXY', 'REG_SZ', ''), valueLine('HTTP_PROXY', 'REG_SZ')]) {
                assert.deepStrictEqual(parseUser([line]), { ...NONE, HTTP_PROXY: '' }, JSON.stringify(line));
            }
        });

        test('keeps leading, inner and trailing spaces of a value', () => {
            assert.strictEqual(parseUser([valueLine('HTTP_PROXY', 'REG_SZ', '   a b  c  ')]).HTTP_PROXY, '   a b  c  ');
        });

        test('keeps a raw line feed inside a value', () => {
            assert.strictEqual(parseUser([valueLine('NO_PROXY', 'REG_SZ', 'a\nb')]).NO_PROXY, 'a\nb');
        });

        test('expands REG_EXPAND_SZ like ExpandEnvironmentStrings', () => {
            const env = { UserProfile: 'C:\\Users\\a', OS: 'Windows_NT', KNOWN: 'k' };
            const expand = (text: string): string | null | undefined =>
                parseUser([valueLine('HTTP_PROXY', 'REG_EXPAND_SZ', text)], env).HTTP_PROXY;

            assert.strictEqual(expand('%USERPROFILE%\\proxy'), 'C:\\Users\\a\\proxy');
            assert.strictEqual(expand('%userprofile%'), 'C:\\Users\\a', 'names are case-insensitive');
            assert.strictEqual(expand('%os%'), 'Windows_NT');
            assert.strictEqual(expand('%UNDEF_X_1%OS%'), '%UNDEF_X_1Windows_NT', 'an unknown name resumes at its closing percent');
            assert.strictEqual(expand('%UNDEF%KNOWN%'), '%UNDEFk');
            assert.strictEqual(expand('a%%b'), 'a%%b');
            assert.strictEqual(expand('abc%'), 'abc%', 'a trailing lone percent stays');
            assert.strictEqual(expand('%'), '%');
            assert.strictEqual(expand('http://u:p%40ss@h:80'), 'http://u:p%40ss@h:80', 'a URL-encoded password stays');
            assert.strictEqual(expand('http://u:p%40a:q%40b@h:80'), 'http://u:p%40a:q%40b@h:80');
            assert.strictEqual(expand('%OS%%OS%'), 'Windows_NTWindows_NT');
        });

        test('REG_SZ is not expanded', () => {
            assert.strictEqual(
                parseUser([valueLine('HTTP_PROXY', 'REG_SZ', '%OS%')], { OS: 'Windows_NT' }).HTTP_PROXY,
                '%OS%'
            );
        });

        test('every other REG type is null, like GetEnvironmentVariable', () => {
            for (const type of ['REG_DWORD', 'REG_MULTI_SZ', 'REG_BINARY', 'REG_QWORD']) {
                assert.deepStrictEqual(parseUser([valueLine('HTTP_PROXY', type, '0x1')]), NONE, type);
            }
        });

        test('a value with a character at or above U+0080 is unknown (undefined), not compared as text', () => {
            for (const text of [`a${replacement}b`, `${nonAscii}A`, `proxy${astral}`, `${nonAscii}%OS%`]) {
                for (const type of ['REG_SZ', 'REG_EXPAND_SZ']) {
                    assert.strictEqual(
                        parseUser([valueLine('HTTP_PROXY', type, text)], { OS: 'Windows_NT' }).HTTP_PROXY,
                        undefined,
                        `${type} ${Array.from(text).map(char => char.codePointAt(0)!.toString(16)).join(' ')}`
                    );
                }
            }
        });

        test('an unknown value does not disturb the other variables, and non-ASCII in another variable is ignored', () => {
            assert.deepStrictEqual(
                parseUser([
                    valueLine('Unrelated', 'REG_SZ', nonAscii),
                    valueLine('HTTP_PROXY', 'REG_SZ', nonAscii),
                    valueLine('HTTPS_PROXY', 'REG_SZ', 'http://secure.example:80')
                ]),
                { ...NONE, HTTP_PROXY: undefined, HTTPS_PROXY: 'http://secure.example:80' }
            );
        });

        test('other variables, a name with spaces, a subkey path and a continuation line are skipped', () => {
            assert.deepStrictEqual(
                parseUser([
                    valueLine('My Variable', 'REG_SZ', 'x'),
                    valueLine('Duplicate', 'REG_SZ', '1'),
                    valueLine('Duplicate', 'REG_SZ', '2'),
                    'a continuation line of an unrelated multi-line value',
                    `${USER_HEADER}\\Volatile`,
                    valueLine('HTTP_PROXY', 'REG_SZ', 'http://proxy.example:8080')
                ]),
                { ...NONE, HTTP_PROXY: 'http://proxy.example:8080' }
            );
        });

        test('the header is checked case-insensitively and may follow blank lines', () => {
            assert.deepStrictEqual(
                parseRegQueryEnvironment(
                    `\r\n\r\n${USER_HEADER.toLowerCase()}\r\n${valueLine('HTTP_PROXY', 'REG_SZ', 'x')}\r\n`,
                    USER_HEADER
                ),
                { ...NONE, HTTP_PROXY: 'x' }
            );
        });

        test('output that is not the key\'s listing is an error, never "absent"', () => {
            const secret = 'http://alice:topsecret@proxy.example:8080';
            const outputs: Array<[string, string]> = [
                ['a header for a different key', regQueryOutput(MACHINE_HEADER, [valueLine('HTTP_PROXY', 'REG_SZ', secret)])],
                ['empty output', ''],
                ['blank output', '\r\n\r\n'],
                ['garbage', `ERROR: ${secret}`],
                ['the value line first', `${valueLine('HTTP_PROXY', 'REG_SZ', secret)}\r\n${USER_HEADER}\r\n`],
                ['a name twice', regQueryOutput(USER_HEADER, [
                    valueLine('HTTP_PROXY', 'REG_SZ', secret),
                    valueLine('HTTP_PROXY', 'REG_SZ', 'other')
                ])],
                ['a name twice, in different case and types', regQueryOutput(USER_HEADER, [
                    valueLine('NO_PROXY', 'REG_SZ', 'a'),
                    valueLine('no_proxy', 'REG_DWORD', '0x1')
                ])]
            ];
            for (const [name, stdout] of outputs) {
                assert.throws(() => parseRegQueryEnvironment(stdout, USER_HEADER), (error: Error) => {
                    assert.ok(!error.message.includes('topsecret'), `${name}: the error repeats output text`);
                    return true;
                }, name);
            }
        });
    });

    suite('readWindowsProxyEnvironment', () => {
        const userOutput = regQueryOutput(USER_HEADER, [valueLine('HTTP_PROXY', 'REG_SZ', 'http://user.example:80')]);
        const machineOutput = regQueryOutput(MACHINE_HEADER, [valueLine('NO_PROXY', 'REG_SZ', 'localhost')]);

        test('queries the user key, then the machine key, one process at a time and without a shell', async () => {
            const signal = new AbortController().signal;
            let running = 0;
            let overlapped = false;
            const exec = sinon.stub().callsFake(async (_file: string, args: string[]) => {
                overlapped = overlapped || running > 0;
                running++;
                await Promise.resolve();
                running--;
                return { stdout: args[1].startsWith('HKCU') ? userOutput : machineOutput };
            });

            const result = await readWindowsProxyEnvironment(signal, exec);

            assert.deepStrictEqual(result, {
                user: { ...NONE, HTTP_PROXY: 'http://user.example:80' },
                machine: { ...NONE, NO_PROXY: 'localhost' }
            });
            assert.deepStrictEqual(exec.args.map(call => [call[0], call[1]]), [
                ['reg', ['query', 'HKCU\\Environment']],
                ['reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']]
            ]);
            for (const call of exec.args) {
                assert.deepStrictEqual(call[2], {
                    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, signal
                });
            }
            assert.strictEqual(overlapped, false);
        });

        test('a non-zero exit, a timeout or a spawn error fails the read', async () => {
            for (const failure of [
                Object.assign(new Error('Command failed: reg query'), { code: 1, stderr: 'ERROR: Access is denied.' }),
                Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }),
                Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' })
            ]) {
                const exec = sinon.stub().rejects(failure);
                await assert.rejects(readWindowsProxyEnvironment(new AbortController().signal, exec), failure);
                assert.strictEqual(exec.callCount, 1, 'the second key is not queried after a failure');
            }
        });

        test('a failing machine key fails the whole read', async () => {
            const exec = sinon.stub();
            exec.onFirstCall().resolves({ stdout: userOutput });
            exec.onSecondCall().rejects(new Error('Command failed'));

            await assert.rejects(readWindowsProxyEnvironment(new AbortController().signal, exec));
        });

        test('output for the wrong key fails the read', async () => {
            const exec = sinon.stub().resolves({ stdout: userOutput });

            await assert.rejects(readWindowsProxyEnvironment(new AbortController().signal, exec));
        });
    });

    test('lists all differing variable names, preserving HTTP and HTTPS independently', async () => {
        for (const name of PROXY_ENVIRONMENT_NAMES) {
            saved.machine[name] = name === 'NO_PROXY' ? 'localhost' : 'http://alice:secret@proxy.example:8080';
        }
        await monitor.check();
        assert.deepStrictEqual(notices, [[...PROXY_ENVIRONMENT_NAMES]]);
        assert.ok(!JSON.stringify(notices).includes('secret'));
        assert.deepStrictEqual(environment, {}, 'read-only comparison');
    });

    test('uses user over machine per variable and compares Windows names case-insensitively', async () => {
        saved.user.HTTP_PROXY = 'http://user.example:80';
        saved.machine.HTTP_PROXY = 'http://machine.example:80';
        saved.machine.HTTPS_PROXY = 'http://secure.example:80';
        environment.http_proxy = saved.user.HTTP_PROXY;
        environment.Https_Proxy = saved.machine.HTTPS_PROXY;
        await monitor.check();
        saved.machine.HTTP_PROXY = 'http://changed-shadowed.example:80';
        await monitor.check();
        assert.deepStrictEqual(notices, []);
        saved.user.HTTP_PROXY = null;
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('ignores process-only startup values but detects additions and subsequent removals', async () => {
        environment.HTTP_PROXY = 'http://old.example:80';
        await monitor.check();
        assert.deepStrictEqual(notices, []);
        saved.user.HTTP_PROXY = environment.HTTP_PROXY;
        await monitor.check();
        saved.user.HTTP_PROXY = null;
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('an empty user value does not hide the machine value (#108)', async () => {
        saved.user.HTTP_PROXY = '';
        saved.machine.HTTP_PROXY = 'http://machine.example:80';
        environment.HTTP_PROXY = saved.machine.HTTP_PROXY;
        await monitor.check();
        assert.deepStrictEqual(notices, [], 'the process already carries the machine value');
        environment.HTTP_PROXY = '';
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']], 'an empty process value differs from the machine value');
    });

    test('an unknown user value is neither compared nor observed, even over a known machine value (#108)', async () => {
        saved.user.HTTP_PROXY = undefined;
        saved.machine.HTTP_PROXY = 'http://machine.example:80';
        await monitor.check();
        environment.HTTP_PROXY = 'http://other.example:80';
        await monitor.check();
        assert.deepStrictEqual(notices, [], 'the unknown user value may shadow the machine value');
        // Never observed: once the user value is known and absent, the machine value is a new observation.
        saved.user.HTTP_PROXY = null;
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('an unknown machine value is skipped only when the user value is absent or empty (#108)', async () => {
        saved.machine.ALL_PROXY = environment.ALL_PROXY = 'http://machine.example:1';
        await monitor.check();
        saved.machine.ALL_PROXY = undefined;
        saved.user.ALL_PROXY = '';
        environment.ALL_PROXY = 'http://changed.example:2';
        await monitor.check();
        saved.user.ALL_PROXY = null;
        await monitor.check();
        assert.deepStrictEqual(notices, [], 'an empty or absent user value over an unknown machine value is skipped');
        saved.user.ALL_PROXY = 'http://user.example:3';
        await monitor.check();
        assert.deepStrictEqual(notices, [['ALL_PROXY']], 'a known user value decides, whatever the machine value is');
    });

    test('an unknown value keeps what was observed before it', async () => {
        saved.user.HTTP_PROXY = environment.HTTP_PROXY = 'http://a.example:80';
        await monitor.check();
        saved.user.HTTP_PROXY = undefined;
        await monitor.check();
        assert.deepStrictEqual(notices, []);
        saved.user.HTTP_PROXY = null;
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']], 'a removal after an unknown poll is still reported');
    });

    test('does not repeat unchanged notices and eventually reports changes after cooldown', async () => {
        saved.user.HTTP_PROXY = 'http://a.example:80';
        await monitor.check();
        await clock.tickAsync(300_000);
        await monitor.check();
        assert.strictEqual(notices.length, 1);
        saved.user.HTTPS_PROXY = 'http://b.example:80';
        await monitor.check();
        saved.user.NO_PROXY = 'localhost';
        await monitor.check();
        assert.strictEqual(notices.length, 2);
        await clock.tickAsync(300_000);
        await monitor.check();
        assert.deepStrictEqual(notices[2], ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
    });

    test('notifies again when a resolved mismatch later recurs', async () => {
        saved.user.HTTP_PROXY = 'http://a.example:80';
        await monitor.check();
        environment.HTTP_PROXY = saved.user.HTTP_PROXY;
        await monitor.check();
        await clock.tickAsync(300_000);
        environment.HTTP_PROXY = 'http://stale.example:80';
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY'], ['HTTP_PROXY']]);
    });

    test('deduplicates concurrent reads and recovers from unavailable tools, denied access and timeouts', async () => {
        saved.user.HTTP_PROXY = 'http://a.example:80';
        for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT']) {
            read.rejects(Object.assign(new Error('private command output'), { code }));
            await Promise.all([monitor.check(), monitor.check(), monitor.check()]);
        }
        assert.strictEqual(read.callCount, 3);
        assert.deepStrictEqual(notices, []);
        read.callsFake(async () => saved);
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('failed reads do not turn a previously observed value into a deletion', async () => {
        saved.user.HTTP_PROXY = environment.HTTP_PROXY = 'http://a.example:80';
        await monitor.check();
        read.rejects(new Error('access denied'));
        await monitor.check();
        assert.deepStrictEqual(notices, []);
        saved.user.HTTP_PROXY = null;
        read.callsFake(async () => saved);
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('dispose aborts the read, suppresses late completion and prevents restart', async () => {
        let complete!: (value: WindowsProxyEnvironmentSnapshot) => void;
        read.callsFake(() => new Promise<WindowsProxyEnvironmentSnapshot>(resolve => { complete = resolve; }));
        monitor.start();
        monitor.start();
        const pending = monitor.check();
        const signal = read.firstCall.args[0] as AbortSignal;
        monitor.dispose();
        assert.strictEqual(signal.aborted, true);
        saved.user.HTTP_PROXY = 'http://a.example:80';
        complete(saved);
        await pending;
        monitor.start();
        await clock.tickAsync(1_000_000);
        assert.strictEqual(read.callCount, 1);
        assert.deepStrictEqual(notices, []);
    });

    test('polls after completion with bounded backoff, then restores normal cadence', async () => {
        read.rejects(new Error('unavailable'));
        monitor.start();
        await clock.tickAsync(0);
        assert.strictEqual(read.callCount, 1);
        await clock.tickAsync(119_999);
        assert.strictEqual(read.callCount, 1);
        await clock.tickAsync(1);
        assert.strictEqual(read.callCount, 2);
        read.resolves(saved);
        await clock.tickAsync(240_000);
        assert.strictEqual(read.callCount, 3);
        await clock.tickAsync(60_000);
        assert.strictEqual(read.callCount, 4);
    });

    test('skips unfocused polling, and reads nothing while notifications are off (#108)', async () => {
        monitor.dispose();
        let focused = false;
        let enabled = false;
        monitor = new WindowsProxyEnvironmentMonitor({
            read, environment, notify: names => notices.push(names),
            isFocused: () => focused, canNotify: () => enabled
        });
        saved.user.HTTP_PROXY = 'http://a.example:80';
        monitor.start();
        await clock.tickAsync(60_000);
        assert.strictEqual(read.callCount, 0);
        focused = true;
        await clock.tickAsync(60_000);
        assert.strictEqual(read.callCount, 0, 'notifications are off: no process is started');
        await monitor.check();
        assert.strictEqual(read.callCount, 0);
        enabled = true;
        await clock.tickAsync(60_000);
        assert.strictEqual(read.callCount, 1);
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });

    test('notifications turned off during a read suppress the notice', async () => {
        let enabled = true;
        monitor.dispose();
        monitor = new WindowsProxyEnvironmentMonitor({
            read, environment, notify: names => notices.push(names), canNotify: () => enabled
        });
        saved.user.HTTP_PROXY = 'http://a.example:80';
        read.callsFake(async () => { enabled = false; return saved; });
        await monitor.check();
        assert.deepStrictEqual(notices, []);
    });
});
