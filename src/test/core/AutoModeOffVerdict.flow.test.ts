/**
 * #97 and #102 end to end: the real ProxyMonitor, real CONNECT sockets, and
 * the three monitor handlers, wired the way ExtensionInitializer wires them
 * (serialized event queue, generation capture, revision-checked state commits).
 *
 * Only DNS is simulated: the tester maps a detected proxy URL to the local
 * endpoint that currently answers for it, so one URL can change behavior
 * between checks the way a network change does.
 */
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { detectionSplitRoutingIdentity, splitRoutingIdentity } from '../../config/DetectedProxyValue';
import {
    handleProxyChanged,
    handleProxyStateChanged,
    handleProxyTestComplete
} from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyMode, ProxyState } from '../../core/types';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyDetectionResult, ProxyMonitor } from '../../monitoring/ProxyMonitor';
import type { ReachabilityChange } from '../../monitoring/ProxyMonitorConnection';
import { testProxyConnectionParallel } from '../../utils/ProxyConnectionTest';
import { TestResult } from '../../utils/ProxyUtils';
import { InputSanitizer } from '../../validation/InputSanitizer';

suite('Auto: OFF verdict through the monitor (#97)', function() {
    this.timeout(15000);

    const primary = 'http://proxy.example.com:8080';
    const other = 'http://proxy2.example.com:8080';
    const testTimeoutMs = 500;

    type Apply = {
        url: string;
        enabled: boolean;
        silent: boolean;
        autoModeOffAtApply: boolean | undefined;
        /** The per-scheme/bypass routing in state when the apply ran; the applier reads it from there. */
        routingAtApply: string;
    };
    /** Per-scheme endpoints and bypass a detection reports next to the primary URL. */
    type Routing = Pick<ProxyDetectionResult, 'kind' | 'httpUrl' | 'httpsUrl' | 'bypass'>;

    let hangServer: net.Server;
    let hangSockets: net.Socket[];
    let authServer: http.Server;
    let hangTarget: string;
    let authTarget: string;
    let refusedTarget: string;
    const dnsTarget = 'http://no-such-host.invalid:8080';

    async function listen(server: net.Server): Promise<number> {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                const address = server.address();
                if (typeof address === 'object' && address !== null) {
                    resolve(address.port);
                    return;
                }
                reject(new Error('Unable to determine test proxy port'));
            });
        });
    }

    async function close(server: net.Server): Promise<void> {
        const closable = server as net.Server & { closeAllConnections?: () => void };
        closable.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }

    suiteSetup(async () => {
        // Takes the TCP connection and never answers CONNECT: the canary or
        // the proxy's upstream is what hangs.
        hangSockets = [];
        hangServer = net.createServer(socket => {
            hangSockets.push(socket);
        });
        hangTarget = `http://127.0.0.1:${await listen(hangServer)}`;

        authServer = http.createServer();
        authServer.on('connect', (_request, socket) => {
            socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            socket.destroy();
        });
        authTarget = `http://127.0.0.1:${await listen(authServer)}`;

        const closed = net.createServer();
        refusedTarget = `http://127.0.0.1:${await listen(closed)}`;
        await close(closed);
    });

    suiteTeardown(async () => {
        for (const socket of hangSockets) {
            socket.destroy();
        }
        await close(hangServer);
        await close(authServer);
    });

    /** One extension window: monitor, handlers, and a revisioned state store. */
    function harness(initial: ProxyState) {
        let stored: ProxyState = { ...initial, revision: 1 };
        const applies: Apply[] = [];
        const routes = new Map<string, string>();
        let detected: string | null = null;
        let detectedRouting: Routing = {};
        /** Runs inside the next connection test, before it connects: another writer's turn. */
        let duringNextTest: (() => Promise<void>) | undefined;

        const store = {
            getState: async (): Promise<ProxyState> => ({ ...stored }),
            saveState: async (next: ProxyState): Promise<void> => {
                stored = { ...next, revision: Math.max(stored.revision ?? 0, next.revision ?? 0) + 1 };
            },
            commitState: async (expectedRevision: number, next: ProxyState) => {
                if ((stored.revision ?? 0) !== expectedRevision) {
                    return { kind: 'superseded' as const, current: { ...stored } };
                }
                stored = { ...next, revision: expectedRevision + 1 };
                return { kind: 'committed' as const, revision: expectedRevision + 1, state: { ...stored } };
            }
        };

        const context = {
            proxyStateManager: store,
            publishProxyState: async () => undefined,
            applyProxySettings: async (url: string, enabled: boolean, options?: { silent?: boolean }) => {
                applies.push({
                    url,
                    enabled,
                    silent: options?.silent === true,
                    autoModeOffAtApply: stored.autoModeOff,
                    routingAtApply: splitRoutingIdentity(stored)
                });
                return true;
            },
            updateStatusBar: () => undefined,
            userNotifier: { showSuccess: () => undefined, showWarning: () => undefined },
            sanitizer: { maskPassword: (url: string) => url }
        } as unknown as InitializerContext;

        const tester = {
            testProxyAuto: async (proxyUrl: string): Promise<TestResult> => {
                const writer = duringNextTest;
                duringNextTest = undefined;
                await writer?.();
                const target = routes.get(proxyUrl);
                assert.ok(target, `no route for ${proxyUrl}`);
                const result = await testProxyConnectionParallel(target, ['https://www.github.com'], testTimeoutMs);
                return { ...result, proxyUrl };
            },
            isTestInProgress: () => false
        } as unknown as ProxyConnectionTester;

        const detector = {
            detectSystemProxy: async () => detected,
            detectSystemProxyWithSource: async () => ({
                proxyUrl: detected,
                source: detected ? 'windows' as const : null,
                ...detectedRouting
            })
        };

        const monitor = new ProxyMonitor(
            detector,
            new ProxyChangeLogger(new InputSanitizer()),
            { maxRetries: 0, debounceDelay: 10 },
            tester
        );
        let queue: Promise<void> = Promise.resolve();
        const enqueue = (task: () => Promise<void>) => {
            queue = queue.then(task, task);
        };
        monitor.on('proxyChanged', (result: ProxyDetectionResult) => enqueue(() => handleProxyChanged(context, result)));
        monitor.on('proxyTestComplete', (result: TestResult) => enqueue(() => handleProxyTestComplete(context, { isPending: false }, result)));
        monitor.on('proxyStateChanged', (data: ReachabilityChange) =>
            enqueue(() => handleProxyStateChanged(context, data)));
        monitor.setGenerationCapture(async () => captureLogicalGeneration(await store.getState()));

        return {
            applies,
            state: () => stored,
            /** A commit by another writer (toggle, sync), the way the state store applies it. */
            write: (change: (current: ProxyState) => ProxyState) => store.saveState(change({ ...stored })),
            duringNextTest(writer: () => Promise<void>): void {
                duringNextTest = writer;
            },
            /** Detect `proxyUrl` with `routing`, answered by `target`, and drain the handlers. */
            async check(proxyUrl: string, target: string, routing: Routing = {}): Promise<void> {
                detected = proxyUrl;
                detectedRouting = routing;
                routes.set(proxyUrl, target);
                await (monitor as unknown as { executeCheck(trigger: string): Promise<unknown> }).executeCheck('focus');
                await queue;
            }
        };
    }

    const offWith = (autoProxyUrl: string | undefined): ProxyState => ({
        mode: ProxyMode.Auto,
        autoProxyUrl,
        autoModeOff: true,
        proxyReachable: false,
        gitConfigured: false,
        npmConfigured: false,
        vscodeConfigured: false
    });
    const onWith = (autoProxyUrl: string): ProxyState => ({
        mode: ProxyMode.Auto,
        autoProxyUrl,
        autoModeOff: false,
        proxyReachable: true,
        gitConfigured: true,
        npmConfigured: true,
        vscodeConfigured: true
    });
    const enables = (applies: Apply[]) => applies.filter(apply => apply.enabled);
    const assertNoEnableUnderAutoOff = (applies: Apply[]) => {
        for (const apply of enables(applies)) {
            assert.strictEqual(apply.autoModeOffAtApply, false, `enabled ${apply.url} under Auto: OFF`);
        }
    };

    test('Auto: OFF stays off on a DNS failure and recovers once the proxy takes the connection', async () => {
        const window = harness(offWith(primary));

        await window.check(primary, dnsTarget);
        assert.strictEqual(enables(window.applies).length, 0, 'a DNS failure proves nothing about the proxy');
        assert.strictEqual(window.state().autoModeOff, true);

        await window.check(primary, hangTarget);
        assertNoEnableUnderAutoOff(window.applies);
        assert.ok(
            enables(window.applies).some(apply => apply.url === primary),
            'TCP connect to the proxy is proof it is alive; leaving Auto: OFF applies it'
        );
        assert.strictEqual(window.state().autoModeOff, false);
    });

    test('Auto: OFF recovers on a 407 from the same proxy', async () => {
        const window = harness(offWith(primary));

        await window.check(primary, authTarget);

        assertNoEnableUnderAutoOff(window.applies);
        assert.ok(enables(window.applies).some(apply => apply.url === primary));
        assert.strictEqual(window.state().autoModeOff, false);
    });

    test('Auto on stays on through a DNS failure and leaves the proxy applied', async () => {
        const window = harness(onWith(primary));

        await window.check(primary, dnsTarget);

        assert.strictEqual(window.applies.filter(apply => !apply.enabled).length, 0);
        assert.strictEqual(window.state().autoModeOff, false);
    });

    test('Auto on turns OFF and removes the proxy when the proxy refuses the connection', async () => {
        const window = harness(onWith(primary));

        await window.check(primary, refusedTarget);

        assert.strictEqual(enables(window.applies).length, 0);
        assert.ok(window.applies.some(apply => !apply.enabled), 'the removal runs');
        assert.strictEqual(window.state().autoModeOff, true);
    });

    for (const [name, target] of [['canary hang', () => hangTarget], ['proxy host DNS failure', () => dnsTarget]] as const) {
        test(`a new proxy from Auto: OFF (no proxy) with a ${name} starts in Auto and is applied`, async () => {
            const window = harness(offWith(undefined));

            await window.check(other, target());

            assertNoEnableUnderAutoOff(window.applies);
            assert.deepStrictEqual(enables(window.applies).map(apply => apply.url), [other]);
            assert.strictEqual(window.state().autoProxyUrl, other);
            assert.strictEqual(window.state().autoModeOff, false);
        });
    }

    test('a new proxy from Auto: OFF (no proxy) that refuses the connection stays OFF and is not enabled', async () => {
        const window = harness(offWith(undefined));

        await window.check(other, refusedTarget);

        assert.strictEqual(enables(window.applies).length, 0);
        assert.strictEqual(window.state().autoModeOff, true);
    });

    test('a proxy change while Auto is on switches to the new proxy', async () => {
        const window = harness(onWith(primary));

        await window.check(other, hangTarget);

        assertNoEnableUnderAutoOff(window.applies);
        assert.deepStrictEqual(enables(window.applies).map(apply => apply.url), [other]);
        assert.strictEqual(window.state().autoProxyUrl, other);
        assert.strictEqual(window.state().autoModeOff, false);
    });

    /**
     * The same primary URL with new per-scheme endpoints or bypass, seen by a
     * check that also runs a connection test. The test result and the
     * reachability flip used to commit first and make the check's proxyChanged
     * stale, so the routing change was lost for good: the monitor does not
     * report it twice (#102).
     */
    suite('a routing change seen by a check that runs a test (#102)', () => {
        const routing: Routing = {
            kind: 'perSchemeProxy',
            httpUrl: primary,
            httpsUrl: 'http://secure2.example.com:8443',
            bypass: 'localhost,*.corp.example.com'
        };
        const newRouting = detectionSplitRoutingIdentity(routing);
        const routingOf = (state: ProxyState) => splitRoutingIdentity(state);
        /** Applies made by the checks after the first `count` applies. */
        const since = (applies: Apply[], count: number) => applies.slice(count);

        test('Auto on: the new routing is saved and applied', async () => {
            const window = harness(onWith(primary));
            await window.check(primary, hangTarget);
            const before = window.applies.length;

            await window.check(primary, hangTarget, routing);

            assert.strictEqual(routingOf(window.state()), newRouting, 'the routing change is saved');
            assert.deepStrictEqual(
                enables(since(window.applies, before)).map(apply => [apply.url, apply.routingAtApply]),
                [[primary, newRouting]],
                'one enable applies the new routing'
            );
            assert.strictEqual(window.state().autoModeOff, false);
        });

        test('Auto on: a proxy that refuses the connection turns Auto OFF, removes the proxy, and keeps the routing', async () => {
            const window = harness(onWith(primary));
            await window.check(primary, hangTarget);
            const before = window.applies.length;

            await window.check(primary, refusedTarget, routing);

            const applied = since(window.applies, before);
            assert.strictEqual(enables(applied).length, 0);
            assert.ok(applied.some(apply => !apply.enabled), 'the removal runs');
            assert.strictEqual(window.state().autoModeOff, true);
            assert.strictEqual(routingOf(window.state()), newRouting, 'the recovery will apply the new routing');
        });

        test('Auto: OFF without proof: the routing is saved and nothing is enabled', async () => {
            const window = harness(offWith(primary));
            await window.check(primary, dnsTarget);

            await window.check(primary, dnsTarget, routing);

            assert.strictEqual(enables(window.applies).length, 0, 'a DNS failure proves nothing about the proxy');
            assert.strictEqual(window.state().autoModeOff, true);
            assert.strictEqual(routingOf(window.state()), newRouting);
        });

        test('Auto: OFF with proof: one enable applies the new routing', async () => {
            const window = harness(offWith(primary));
            await window.check(primary, dnsTarget);
            const before = window.applies.length;

            await window.check(primary, authTarget, routing);

            assertNoEnableUnderAutoOff(window.applies);
            assert.deepStrictEqual(
                enables(since(window.applies, before)).map(apply => [apply.url, apply.routingAtApply]),
                [[primary, newRouting]],
                'the recovery applies the new routing, once'
            );
            assert.strictEqual(window.state().autoModeOff, false);
        });

        const writers: Array<[string, (current: ProxyState) => ProxyState]> = [
            ['a toggle to Off', current => ({ ...current, mode: ProxyMode.Off })],
            // Auto → Off → Auto keeps every logical identity; only the revision tells.
            ['a toggle round trip back to Auto', current => ({ ...current })]
        ];
        for (const [name, change] of writers) {
            test(`${name} during the check: the check's routing is not applied over it`, async () => {
                const window = harness(onWith(primary));
                await window.check(primary, hangTarget);
                const before = window.applies.length;
                window.duringNextTest(() => window.write(change));

                await window.check(primary, hangTarget, routing);

                assert.deepStrictEqual(
                    since(window.applies, before).filter(apply => apply.routingAtApply === newRouting),
                    [],
                    'the generation fence still drops a check that started before the other writer'
                );
                assert.notStrictEqual(routingOf(window.state()), newRouting);
            });
        }

        test('a check without a routing change does not re-apply (first check after start)', async () => {
            // A known enable failure makes proxyChanged re-apply whenever it
            // runs; the first check reports proxyChanged without any change.
            const window = harness({ ...onWith(primary), gitConfigured: false });

            await window.check(primary, hangTarget);

            assert.deepStrictEqual(
                window.applies.filter(apply => !apply.silent),
                [],
                'only the silent reachability re-apply runs, as before'
            );
        });
    });
});
