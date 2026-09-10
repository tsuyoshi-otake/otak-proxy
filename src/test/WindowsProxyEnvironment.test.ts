import * as assert from 'assert';
import * as sinon from 'sinon';
import {
    parseWindowsProxyEnvironment,
    PROXY_ENVIRONMENT_NAMES,
    ProxyEnvironmentName,
    WindowsProxyEnvironmentMonitor,
    WindowsProxyEnvironmentSnapshot
} from '../monitoring/WindowsProxyEnvironment';

function snapshot(): WindowsProxyEnvironmentSnapshot {
    const empty = { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null };
    return { user: { ...empty }, machine: { ...empty } };
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
        read = sinon.stub().callsFake(async () => parseWindowsProxyEnvironment(JSON.stringify(saved)));
        monitor = new WindowsProxyEnvironmentMonitor({
            read, environment, notify: names => notices.push(names), random: () => 0
        });
    });
    teardown(() => { monitor.dispose(); clock.restore(); });

    test('validates complete protocol responses without reflecting sensitive input in errors', () => {
        assert.deepStrictEqual(parseWindowsProxyEnvironment(JSON.stringify(saved)), saved);
        for (const value of [null, {}, { user: {} }, { ...saved, machine: { HTTP_PROXY: 42 } }]) {
            assert.throws(() => parseWindowsProxyEnvironment(JSON.stringify(value)));
        }
        assert.throws(() => parseWindowsProxyEnvironment('{'));
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

    test('empty user values mask machine values without reporting empty process values', async () => {
        saved.user.HTTP_PROXY = '';
        saved.machine.HTTP_PROXY = 'http://machine.example:80';
        environment.HTTP_PROXY = '';
        await monitor.check();
        assert.deepStrictEqual(notices, []);
        environment.HTTP_PROXY = saved.machine.HTTP_PROXY;
        await monitor.check();
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
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

    test('skips unfocused polling and leaves suppressed notices eligible when enabled', async () => {
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
        assert.strictEqual(read.callCount, 1);
        assert.strictEqual(notices.length, 0);
        enabled = true;
        await clock.tickAsync(60_000);
        assert.deepStrictEqual(notices, [['HTTP_PROXY']]);
    });
});
