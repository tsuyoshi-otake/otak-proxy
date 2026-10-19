import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyMonitor, ProxyDetectionResult } from '../monitoring/ProxyMonitor';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { ProxyConnectionTester } from '../monitoring/ProxyConnectionTester';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { InputSanitizer } from '../validation/InputSanitizer';
import { UserNotifier } from '../errors/UserNotifier';
import type { ProxyCheckTrigger } from '../monitoring/ProxyMonitorTypes';
import type { TestResult } from '../utils/ProxyUtils';

type ExecuteCheck = (trigger: ProxyCheckTrigger) => Promise<ProxyDetectionResult>;

function executeCheckOf(monitor: ProxyMonitor): ExecuteCheck {
    return (trigger) => (monitor as unknown as { executeCheck: ExecuteCheck }).executeCheck(trigger);
}

suite('ProxyMonitor failed detection (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let monitor: ProxyMonitor | undefined;
    let logger: ProxyChangeLogger;

    setup(() => {
        sandbox = sinon.createSandbox();
        logger = new ProxyChangeLogger(new InputSanitizer());
    });

    teardown(() => {
        monitor?.stop();
        monitor = undefined;
        sandbox.restore();
    });

    suite('an unknown detection', () => {
        // Every variable the environment source reads: an inherited or leaked
        // HTTPS_PROXY would otherwise answer the second detection (#108).
        const proxyEnvironment = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
        let savedEnvironment: Array<[string, string | undefined]> = [];

        setup(() => {
            savedEnvironment = proxyEnvironment.map(name => [name, process.env[name]]);
            for (const name of proxyEnvironment) {
                delete process.env[name];
            }
        });

        teardown(() => {
            for (const [name, value] of savedEnvironment) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
        });

        test('keeps the last proxy, emits no proxyChanged, and reaches allRetriesFailed', async () => {
            process.env.HTTP_PROXY = 'http://env-proxy.example.com:8080';
            const detector = new SystemProxyDetector(['environment', 'platform']);
            sandbox.stub(detector as unknown as { exec(): Promise<never> }, 'exec')
                .rejects(new Error('Command failed: platform query'));
            monitor = new ProxyMonitor(detector, logger, {
                pollingInterval: 60_000,
                debounceDelay: 1,
                maxRetries: 1,
                retryBackoffBase: 0.001,
                enableConnectionTest: false
            });
            const changes: ProxyDetectionResult[] = [];
            const exhausted: Array<{ error: string }> = [];
            monitor.on('proxyChanged', (result: ProxyDetectionResult) => changes.push(result));
            monitor.on('allRetriesFailed', (data: { error: string }) => exhausted.push(data));
            monitor.start();

            const first = await executeCheckOf(monitor)('network');
            assert.strictEqual(first.success, true);
            assert.strictEqual(first.proxyUrl, 'http://env-proxy.example.com:8080');
            assert.strictEqual(changes.length, 1, 'the first detection is a change');

            delete process.env.HTTP_PROXY;
            const second = await executeCheckOf(monitor)('network');

            assert.strictEqual(second.success, false, 'unknown is a failed detection');
            assert.match(second.error ?? '', /platform query/);
            assert.strictEqual(changes.length, 1, 'no proxyChanged on unknown');
            assert.strictEqual(monitor.getState().currentProxy, 'http://env-proxy.example.com:8080', 'last proxy is kept');
            assert.strictEqual(monitor.getState().consecutiveFailures, 1);
            assert.strictEqual(exhausted.length, 1, 'allRetriesFailed is reachable with the real detector');
        });
    });

    suite('a generation capture that rejects', () => {
        function monitorWithBrokenCapture(detect: sinon.SinonStub): ProxyMonitor {
            const created = new ProxyMonitor({ detectSystemProxy: detect }, logger, {
                pollingInterval: 60_000,
                debounceDelay: 1000,
                maxRetries: 0,
                enableConnectionTest: false
            });
            created.setGenerationCapture(async () => {
                throw new Error('state store unavailable');
            });
            return created;
        }

        function collectEvents(target: ProxyMonitor): string[] {
            const events: string[] = [];
            for (const name of ['checkComplete', 'proxyChanged', 'proxyTestComplete', 'allRetriesFailed']) {
                target.on(name, () => events.push(name));
            }
            return events;
        }

        test('executeCheck twice in a row: each ends as a failed detection and the second is not "in progress"', async () => {
            const detect = sandbox.stub().resolves('http://proxy.example.com:8080');
            monitor = monitorWithBrokenCapture(detect);
            const events = collectEvents(monitor);
            monitor.start();
            const execute = executeCheckOf(monitor);

            const first = await execute('network');
            const second = await execute('network');

            for (const result of [first, second]) {
                assert.strictEqual(result.success, false);
                assert.match(result.error ?? '', /Generation capture failed: state store unavailable/);
            }
            assert.notStrictEqual(second.error, 'Check already in progress');
            assert.deepStrictEqual(events, [], 'a failed capture emits nothing');
            assert.strictEqual(detect.callCount, 0, 'detection does not run without the fence');
            assert.strictEqual(monitor.getState().consecutiveFailures, 2);
        });

        test('a capture that rejects after stop() and a new start() does not count against the new lifecycle', async () => {
            const detect = sandbox.stub().resolves('http://proxy.example.com:8080');
            let rejectCapture: (error: Error) => void = () => undefined;
            monitor = new ProxyMonitor({ detectSystemProxy: detect }, logger, {
                pollingInterval: 60_000,
                debounceDelay: 1000,
                maxRetries: 0,
                enableConnectionTest: false
            });
            monitor.setGenerationCapture(() => new Promise((_resolve, reject) => { rejectCapture = reject; }));
            monitor.start();

            const pending = executeCheckOf(monitor)('network');
            monitor.stop();
            monitor.start();
            rejectCapture(new Error('state store unavailable'));
            const result = await pending;

            assert.strictEqual(result.success, false);
            assert.strictEqual(monitor.getState().consecutiveFailures, 0, 'the ended lifecycle records no failure');
        });

        test('through triggerCheck and the debounce timer: no unhandled rejection, flag released', async () => {
            const realSetImmediate = setImmediate;
            const detect = sandbox.stub().resolves('http://proxy.example.com:8080');
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown) => unhandled.push(reason);
            process.on('unhandledRejection', onUnhandled);
            const clock = sinon.useFakeTimers();
            try {
                monitor = monitorWithBrokenCapture(detect);
                monitor.start();

                monitor.triggerCheck('focus');
                await clock.tickAsync(1000);
                // Node reports an unhandled rejection after the microtask queue drains.
                await new Promise<void>(resolve => realSetImmediate(resolve));
                await new Promise<void>(resolve => realSetImmediate(resolve));

                assert.deepStrictEqual(unhandled, [], 'the debounce callback leaks no unhandled rejection');
                assert.strictEqual(monitor.getState().consecutiveFailures, 1);
                const second = await executeCheckOf(monitor)('network');
                assert.notStrictEqual(second.error, 'Check already in progress');
            } finally {
                clock.restore();
                process.off('unhandledRejection', onUnhandled);
            }
        });

        test('a later check works once the capture recovers', async () => {
            let broken = true;
            monitor = new ProxyMonitor({ detectSystemProxy: async () => 'http://proxy.example.com:8080' }, logger, {
                pollingInterval: 60_000,
                debounceDelay: 1,
                maxRetries: 0,
                enableConnectionTest: false
            });
            monitor.setGenerationCapture(async () => {
                if (broken) {
                    throw new Error('state store unavailable');
                }
                return undefined;
            });
            monitor.start();
            const execute = executeCheckOf(monitor);

            await execute('network');
            broken = false;
            const recovered = await execute('network');

            assert.strictEqual(recovered.success, true);
            assert.strictEqual(recovered.proxyUrl, 'http://proxy.example.com:8080');
        });
    });

    suite('connection test cadence with the default intervals', () => {
        test('polling runs a test every 60 s even when each test takes a few seconds', async () => {
            const clock = sinon.useFakeTimers();
            try {
                const notifier = sandbox.createStubInstance(UserNotifier);
                const tester = new ProxyConnectionTester(notifier as unknown as UserNotifier);
                const startedAt: number[] = [];
                sandbox.stub(tester, 'testProxyAuto').callsFake(async (proxyUrl: string): Promise<TestResult> => {
                    startedAt.push(Date.now());
                    // The test takes 2 s of fake time and is stamped with its end time.
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    return {
                        success: true,
                        testUrls: [],
                        errors: [],
                        proxyUrl,
                        timestamp: Date.now(),
                        duration: 2000
                    };
                });
                monitor = new ProxyMonitor({ detectSystemProxy: async () => 'http://proxy.example.com:8080' }, logger, {}, tester);
                monitor.start();

                await clock.tickAsync(160_000);

                assert.deepStrictEqual(startedAt, [31_000, 91_000, 151_000], 'tests are 60 s apart');
            } finally {
                clock.restore();
            }
        });
    });
});
