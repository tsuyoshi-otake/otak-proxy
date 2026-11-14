/**
 * #136 item 1 end to end: a proxyChanged the handler drops as stale is
 * reported again, through the wiring ExtensionInitializer really has: the real
 * ProxyMonitor, the real handlers on the serialized event queue, and the real
 * ProxyStateManager with its revision-checked commits.
 *
 * "Another writer commits during the check" stands for the scheduler's test
 * completion, a sync, or a toggle: anything that advances the state's
 * generation after the check captured it.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ExtensionInitializer } from '../../core/ExtensionInitializer';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import * as EventHandlers from '../../core/ExtensionProxyEventHandlers';
import { handleProxyChanged } from '../../core/ExtensionProxyEventHandlers';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyMode, ProxyState } from '../../core/types';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { ProxyConnectionTester } from '../../monitoring/ProxyConnectionTester';
import { ProxyDetectionResult } from '../../monitoring/ProxyMonitorTypes';
import { TestResult } from '../../utils/ProxyUtils';
import { InputSanitizer } from '../../validation/InputSanitizer';
import { createRealStateManager } from '../realProxyStateManager';

const X = 'http://proxy-x.example.com:8080';
const Y = 'http://proxy-y.example.com:8080';
const Z = 'http://proxy-z.example.com:8080';

const onWith = (autoProxyUrl: string): ProxyState => ({
    mode: ProxyMode.Auto,
    autoProxyUrl,
    autoModeOff: false,
    proxyReachable: true,
    gitConfigured: true,
    npmConfigured: true,
    vscodeConfigured: true
});

const detectionOf = (proxyUrl: string): ProxyDetectionResult => ({
    proxyUrl,
    source: 'windows',
    kind: 'singleProxy',
    capability: 'supported',
    httpUrl: proxyUrl,
    httpsUrl: proxyUrl,
    timestamp: 1,
    success: true
});

function okTest(proxyUrl: string): TestResult {
    return {
        success: true,
        testUrls: ['https://www.github.com'],
        errors: [],
        proxyUrl,
        timestamp: Date.now(),
        duration: 1,
        proxyEndpointOk: true
    };
}

suite('Proxy change the handler did not adopt (#136)', function() {
    this.timeout(15000);

    let sandbox: sinon.SinonSandbox;
    let stopWindow: (() => void) | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        stopWindow?.();
        stopWindow = undefined;
        sandbox.restore();
    });

    /** One extension window: ExtensionInitializer's monitor, handlers and queue over a real state store. */
    async function openWindow(initial: ProxyState) {
        const real = createRealStateManager();
        await real.manager.getState();
        await real.manager.saveState(initial);

        const applies: Array<{ url: string; enabled: boolean }> = [];
        let detected: string | null = null;
        let duringNextDetection: (() => Promise<void>) | undefined;

        const context = {
            extensionContext: real.extensionContext,
            proxyStateManager: real.manager,
            proxyApplier: {},
            publishProxyState: async () => undefined,
            applyProxySettings: async (url: string, enabled: boolean) => {
                applies.push({ url, enabled });
                return true;
            },
            systemProxyDetector: {
                updateDetectionPriority: () => undefined,
                detectSystemProxy: async () => detected,
                detectSystemProxyWithSource: async () => {
                    const writer = duringNextDetection;
                    duringNextDetection = undefined;
                    await writer?.();
                    return { proxyUrl: detected, source: detected ? 'windows' as const : null };
                }
            },
            updateStatusBar: () => undefined,
            userNotifier: { showSuccess: () => undefined, showWarning: () => undefined },
            sanitizer: new InputSanitizer(),
            proxyChangeLogger: new ProxyChangeLogger(new InputSanitizer())
        } as unknown as InitializerContext;

        const initializer = new ExtensionInitializer(context);
        const monitor = initializer.initializeProxyMonitor();
        const reported: Array<string | null> = [];
        monitor.on('proxyChanged', (result: ProxyDetectionResult) => reported.push(result.proxyUrl));
        monitor.start();
        stopWindow = () => monitor.stop();

        const queue = () => (initializer as unknown as { proxyMonitorEventQueue: Promise<void> }).proxyMonitorEventQueue;

        return {
            monitor,
            applies,
            reported,
            state: () => real.manager.getState(),
            /** A commit by another writer. */
            async write(change: (current: ProxyState) => ProxyState): Promise<void> {
                await real.manager.saveState(change(await real.manager.getState()));
            },
            /** Runs inside the next detection, after the check captured its generation. */
            duringNextDetection(writer: () => Promise<void>): void {
                duringNextDetection = writer;
            },
            /** One check that detects `proxyUrl`, and the handlers it triggers. */
            async check(proxyUrl: string): Promise<void> {
                detected = proxyUrl;
                await (monitor as unknown as { executeCheck(trigger: string): Promise<unknown> }).executeCheck('polling');
                await queue();
            }
        };
    }

    test('a change dropped as stale is reported again at the next check and applied then', async () => {
        const window = await openWindow(onWith(X));
        await window.check(X);

        window.duringNextDetection(() => window.write(current => ({ ...current, proxyReachable: true })));
        await window.check(Y);
        assert.strictEqual((await window.state()).autoProxyUrl, X, 'precondition: the change was dropped as stale');
        assert.deepStrictEqual(window.reported, [X, Y]);

        await window.check(Y);

        assert.strictEqual(
            (await window.state()).autoProxyUrl,
            Y,
            'the change the handler dropped is reported at the next check and adopted'
        );
        assert.deepStrictEqual(window.applies, [{ url: Y, enabled: true }]);
        assert.deepStrictEqual(window.reported, [X, Y, Y]);

        await window.check(Y);
        assert.deepStrictEqual(window.reported, [X, Y, Y], 'an adopted change is not reported a third time');
    });

    test('a change the state already holds is not reported again, however the check ordered its events', async () => {
        // The check tests the endpoint first and the test result commits, which
        // advances the generation: the proxyChanged that follows is stale, and
        // the state already holds what it reports.
        sandbox.stub(ProxyConnectionTester.prototype, 'testProxyAuto').callsFake(async (url: string) => okTest(url));
        const window = await openWindow(onWith(Y));
        window.monitor.updateConfig({ enableConnectionTest: true });

        await window.check(Y);
        await window.check(Y);
        await window.check(Y);

        assert.deepStrictEqual(window.reported, [Y], 'one report; the dropped copy did not make the monitor report every check');
    });

    test('a change dropped because the mode left Auto is not reported again', async () => {
        const window = await openWindow(onWith(X));
        await window.check(X);

        window.duringNextDetection(() => window.write(current => ({ ...current, mode: ProxyMode.Off })));
        await window.check(Y);
        await window.check(Y);
        await window.check(Y);

        assert.deepStrictEqual(window.reported, [X, Y]);
        assert.strictEqual((await window.state()).autoProxyUrl, X);
        assert.deepStrictEqual(window.applies, []);
    });

    test('a change dropped because a newer detection was adopted ends once the detection matches the state', async () => {
        const window = await openWindow(onWith(X));
        await window.check(X);

        // Another path (startup, a sync) adopts Z while the check detects Y.
        window.duringNextDetection(() => window.write(current => ({ ...current, autoProxyUrl: Z })));
        await window.check(Y);
        assert.strictEqual((await window.state()).autoProxyUrl, Z, 'precondition: Z was adopted behind the check');

        // The OS now reports Z; every later check says the same.
        await window.check(Z);
        await window.check(Z);
        await window.check(Z);

        assert.strictEqual((await window.state()).autoProxyUrl, Z);
        assert.deepStrictEqual(window.reported, [X, Y, Z], 'Z is reported once and no check after it reports again');
        assert.deepStrictEqual(window.applies.filter(apply => apply.url === Y), [], 'Y was never applied');
    });

    test('a handler that throws still answers the report: a bounded not-adopted', async () => {
        const window = await openWindow(onWith(X));
        await window.check(X);

        // The report's handler rejects before it can answer: without an
        // explicit answer the report stays outstanding forever — no re-report,
        // and the rejection streak can never reset (#136).
        let thrown = false;
        const realHandleProxyChanged = EventHandlers.handleProxyChanged;
        sandbox.stub(EventHandlers, 'handleProxyChanged').callsFake(async (context, result, fallback) => {
            if (!thrown) {
                thrown = true;
                throw new Error('handler boom');
            }
            return realHandleProxyChanged(context, result, fallback);
        });

        await window.check(Y);
        await window.check(Y);

        assert.deepStrictEqual(
            window.reported,
            [X, Y, Y],
            'the throwing report is answered not-adopted and reported again at the next check'
        );
        assert.strictEqual((await window.state()).autoProxyUrl, Y, 'the recovered report adopts the detection');
        assert.deepStrictEqual(window.applies, [{ url: Y, enabled: true }]);
    });
});

suite('handleProxyChanged outcome (#136)', function() {
    this.timeout(15000);

    async function setup(initial: ProxyState) {
        const real = createRealStateManager();
        await real.manager.getState();
        await real.manager.saveState(initial);
        const applies: Array<{ url: string; enabled: boolean }> = [];
        const warnings: string[] = [];
        const context = {
            proxyStateManager: real.manager,
            publishProxyState: async () => undefined,
            applyProxySettings: async (url: string, enabled: boolean) => {
                applies.push({ url, enabled });
                return true;
            },
            updateStatusBar: () => undefined,
            userNotifier: { showSuccess: () => undefined, showWarning: (key: string) => warnings.push(key) },
            sanitizer: new InputSanitizer()
        } as unknown as InitializerContext;
        return { real, context, applies, warnings };
    }

    /** A report whose check started before `generationBefore` advanced. */
    async function staleReport(window: Awaited<ReturnType<typeof setup>>, detectedUrl: string): Promise<ProxyDetectionResult> {
        const startedGeneration = captureLogicalGeneration(await window.real.manager.getState());
        await window.real.manager.saveState(await window.real.manager.getState());
        return { ...detectionOf(detectedUrl), startedGeneration };
    }

    test('a report that was stale and differs from the state: notAdopted', async () => {
        const window = await setup(onWith(X));
        const report = await staleReport(window, Y);

        assert.strictEqual(await handleProxyChanged(window.context, report), 'notAdopted');
        assert.deepStrictEqual(window.applies, []);
    });

    test('a report that was stale and already holds in the state: settled', async () => {
        const window = await setup(onWith(Y));
        const report = await staleReport(window, Y);

        assert.strictEqual(await handleProxyChanged(window.context, report), 'settled');
    });

    test('a report that was stale and arrives in a mode other than Auto: settled', async () => {
        const window = await setup({ ...onWith(X), mode: ProxyMode.Off });
        const report = await staleReport(window, Y);

        assert.strictEqual(await handleProxyChanged(window.context, report), 'settled');
    });

    test('a report that passed the fence and was applied: settled', async () => {
        const window = await setup(onWith(X));
        const report = {
            ...detectionOf(Y),
            startedGeneration: captureLogicalGeneration(await window.real.manager.getState())
        };

        assert.strictEqual(await handleProxyChanged(window.context, report), 'settled');
        assert.deepStrictEqual(window.applies, [{ url: Y, enabled: true }]);
    });

    test('a PAC record dropped at the commit announces nothing; the report that adopts it warns once', async () => {
        const window = await setup(onWith(X));
        const pac: ProxyDetectionResult = {
            proxyUrl: null,
            source: 'windows',
            kind: 'pac',
            capability: 'unsupported',
            timestamp: 1,
            success: true,
            startedGeneration: captureLogicalGeneration(await window.real.manager.getState())
        };
        const manager = window.real.manager;
        const realCommit = manager.commitState.bind(manager);
        const stub = sinon.stub(manager, 'commitState').callsFake(async (expectedRevision, next) => {
            stub.restore();
            await manager.saveState({ ...await manager.getState(), proxyReachable: true });
            return realCommit(expectedRevision, next);
        });

        try {
            assert.strictEqual(await handleProxyChanged(window.context, pac), 'notAdopted');
        } finally {
            stub.restore();
        }
        assert.deepStrictEqual(window.warnings, [], 'the record was dropped');

        const again = { ...pac, startedGeneration: captureLogicalGeneration(await manager.getState()) };
        assert.strictEqual(await handleProxyChanged(window.context, again), 'settled');
        assert.deepStrictEqual(window.warnings, ['warning.unsupportedAutoConfig']);
    });

    test('a commit lost to another writer between the read and the write: notAdopted', async () => {
        const window = await setup(onWith(X));
        const report = {
            ...detectionOf(Y),
            startedGeneration: captureLogicalGeneration(await window.real.manager.getState())
        };
        // The report passes the fence at the handler's read; another writer
        // commits before the handler's own compare-and-set lands.
        const manager = window.real.manager;
        const realCommit = manager.commitState.bind(manager);
        const stub = sinon.stub(manager, 'commitState').callsFake(async (expectedRevision, next) => {
            stub.restore();
            await manager.saveState({ ...await manager.getState(), proxyReachable: true });
            return realCommit(expectedRevision, next);
        });

        try {
            assert.strictEqual(await handleProxyChanged(window.context, report), 'notAdopted');
            assert.deepStrictEqual(window.applies, []);
        } finally {
            stub.restore();
        }
    });
});
