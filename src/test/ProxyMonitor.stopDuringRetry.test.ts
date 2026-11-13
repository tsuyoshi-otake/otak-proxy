/**
 * #136 item 2: after stop() no detection attempt runs and no allRetriesFailed
 * is emitted for the stopped lifecycle. The retry backoff is a timer: stop()
 * ends it instead of leaving it to fire.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { ProxyDetectionResult, ProxyMonitor } from '../monitoring/ProxyMonitor';
import type { ProxyCheckTrigger } from '../monitoring/ProxyMonitorTypes';
import { InputSanitizer } from '../validation/InputSanitizer';

type ExecuteCheck = (trigger: ProxyCheckTrigger) => Promise<ProxyDetectionResult>;

function executeCheckOf(monitor: ProxyMonitor): ExecuteCheck {
    return (trigger) => (monitor as unknown as { executeCheck: ExecuteCheck }).executeCheck(trigger);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

suite('ProxyMonitor stop() during detection retries (#136)', () => {
    let sandbox: sinon.SinonSandbox;
    let monitor: ProxyMonitor | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        monitor?.stop();
        monitor = undefined;
        sandbox.restore();
    });

    function createMonitor(
        detect: sinon.SinonStub,
        config: { maxRetries: number; retryBackoffBase: number }
    ): { monitor: ProxyMonitor; exhausted: unknown[]; events: string[] } {
        const created = new ProxyMonitor(
            { detectSystemProxy: detect },
            new ProxyChangeLogger(new InputSanitizer()),
            { pollingInterval: 60_000, debounceDelay: 1000, enableConnectionTest: false, ...config }
        );
        const exhausted: unknown[] = [];
        const events: string[] = [];
        created.on('allRetriesFailed', (data: unknown) => exhausted.push(data));
        for (const name of ['checkComplete', 'proxyChanged', 'proxyTestComplete']) {
            created.on(name, () => events.push(name));
        }
        monitor = created;
        return { monitor: created, exhausted, events };
    }

    test('stop() during the backoff ends the sleep: no timer is left and no later attempt runs', async () => {
        const clock = sandbox.useFakeTimers();
        const detect = sandbox.stub().rejects(new Error('platform query failed'));
        const { monitor: target, exhausted, events } = createMonitor(detect, { maxRetries: 3, retryBackoffBase: 1 });
        target.start();
        const pending = executeCheckOf(target)('polling');
        await clock.tickAsync(10);
        assert.strictEqual(detect.callCount, 1, 'precondition: the first attempt failed and the check sleeps in its backoff');

        target.stop();

        assert.strictEqual(clock.countTimers(), 0, 'stop() leaves no backoff timer behind');
        const result = await pending;
        assert.strictEqual(result.success, false);
        await clock.tickAsync(60_000);
        assert.strictEqual(detect.callCount, 1, 'no detection attempt runs after stop()');
        assert.deepStrictEqual(exhausted, [], 'allRetriesFailed is not emitted for the stopped lifecycle');
        assert.deepStrictEqual(events, [], 'a stopped check publishes nothing');
    });

    test('stop() while an attempt is in flight: its failure neither retries nor emits allRetriesFailed', async () => {
        for (const maxRetries of [0, 2]) {
            const attempt = deferred<string | null>();
            const detect = sandbox.stub().returns(attempt.promise);
            const { monitor: target, exhausted, events } = createMonitor(detect, { maxRetries, retryBackoffBase: 0.001 });
            target.start();
            const pending = executeCheckOf(target)('polling');
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(detect.callCount, 1, `precondition (maxRetries ${maxRetries}): the attempt is in flight`);

            target.stop();
            attempt.reject(new Error('platform query failed'));
            await pending;
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.strictEqual(detect.callCount, 1, `maxRetries ${maxRetries}: no further attempt after stop()`);
            assert.deepStrictEqual(exhausted, [], `maxRetries ${maxRetries}: no allRetriesFailed after stop()`);
            assert.deepStrictEqual(events, [], `maxRetries ${maxRetries}: a stopped check publishes nothing`);
            target.stop();
        }
    });

    test('stop() while the generation is being captured: the check never runs a detection', async () => {
        const capture = deferred<undefined>();
        const detect = sandbox.stub().resolves('http://proxy.example.com:8080');
        const { monitor: target, exhausted, events } = createMonitor(detect, { maxRetries: 2, retryBackoffBase: 0.001 });
        target.setGenerationCapture(() => capture.promise);
        target.start();
        const pending = executeCheckOf(target)('polling');
        await new Promise(resolve => setImmediate(resolve));

        target.stop();
        capture.resolve(undefined);
        await pending;

        assert.strictEqual(detect.callCount, 0, 'no detection attempt for a stopped lifecycle');
        assert.deepStrictEqual(exhausted, []);
        assert.deepStrictEqual(events, []);
    });

    test('stop() then start(): the old check ends and the new lifecycle detects normally', async () => {
        const clock = sandbox.useFakeTimers();
        const detect = sandbox.stub();
        detect.onFirstCall().rejects(new Error('platform query failed'));
        detect.resolves('http://proxy.example.com:8080');
        const { monitor: target, exhausted } = createMonitor(detect, { maxRetries: 3, retryBackoffBase: 1 });
        target.start();
        const old = executeCheckOf(target)('polling');
        await clock.tickAsync(10);

        target.stop();
        target.start();
        const fresh = await executeCheckOf(target)('polling');
        await old;

        assert.strictEqual(fresh.success, true);
        assert.strictEqual(fresh.proxyUrl, 'http://proxy.example.com:8080');
        assert.strictEqual(detect.callCount, 2, 'one attempt of the old check, one of the new');
        assert.deepStrictEqual(exhausted, []);
    });

    test('without stop(), retries still run and allRetriesFailed is emitted once', async () => {
        const detect = sandbox.stub().rejects(new Error('platform query failed'));
        const { monitor: target, exhausted } = createMonitor(detect, { maxRetries: 2, retryBackoffBase: 0.001 });
        target.start();

        const result = await executeCheckOf(target)('polling');

        assert.strictEqual(result.success, false);
        assert.strictEqual(detect.callCount, 3, 'the first attempt and two retries');
        assert.strictEqual(exhausted.length, 1);
    });
});
