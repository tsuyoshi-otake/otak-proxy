import * as assert from 'assert';
import * as sinon from 'sinon';
import { ExtensionInitializer } from '../../core/ExtensionInitializer';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState, StateCommitResult } from '../../core/types';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { InputSanitizer } from '../../validation/InputSanitizer';
import * as SystemProxyDetectionUtils from '../../utils/SystemProxyDetectionUtils';
import { createRealStateManager } from '../realProxyStateManager';

/**
 * #108: startSystemProxyMonitoring must not depend on the per-window
 * revision matching between two reads. A missing revision (fresh install,
 * migrated state) or a revision-only commit between the reads must not stop
 * monitoring from starting; a mode change to Off still does.
 */
suite('startSystemProxyMonitoring revision handling (#108)', function() {
    this.timeout(30000);

    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(SystemProxyDetectionUtils, 'detectSystemProxySettingsWithSource').resolves({
            proxyUrl: 'http://detected.example:8080',
            source: 'environment',
            kind: 'singleProxy',
            capability: 'supported'
        } as never);
    });

    teardown(() => {
        sandbox.restore();
    });

    function createInitializer(
        manager: ReturnType<typeof createRealStateManager>['manager'],
        extensionContext: ReturnType<typeof createRealStateManager>['extensionContext']
    ) {
        const sanitizer = new InputSanitizer();
        const published: ProxyState[] = [];
        const applied: Array<{ url: string; enabled: boolean }> = [];
        const context = {
            extensionContext,
            proxyStateManager: manager,
            proxyApplier: {},
            applyProxySettings: async (url: string, enabled: boolean) => {
                applied.push({ url, enabled });
                return true;
            },
            systemProxyDetector: {
                updateDetectionPriority: () => undefined,
                detectSystemProxyWithSource: async () => ({
                    proxyUrl: 'http://detected.example:8080',
                    source: 'environment'
                })
            },
            userNotifier: {
                showSuccess: () => undefined,
                showWarning: () => undefined,
                showError: () => undefined
            },
            sanitizer,
            proxyChangeLogger: new ProxyChangeLogger(sanitizer),
            publishProxyState: async (state: ProxyState) => { published.push({ ...state }); }
        } as unknown as InitializerContext;
        return { initializer: new ExtensionInitializer(context), published, applied };
    }

    test('starts when the stored state has no revision', async () => {
        const harness = createRealStateManager();
        // A state persisted without a revision: fresh install or migrated.
        await harness.extensionContext.globalState.update('proxyState', {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://detected.example:8080',
            proxyReachable: true
        });
        const { initializer, published } = createInitializer(harness.manager, harness.extensionContext);

        await initializer.startSystemProxyMonitoring();

        assert.ok(published.length >= 1, 'the monitoring start path must run to its publish');
        assert.strictEqual(harness.persistedState()?.proxyReachable, undefined);
        assert.strictEqual(typeof harness.persistedState()?.revision, 'number');
    });

    test('starts when a revision-only commit lands between its reads', async () => {
        const harness = createRealStateManager();
        await harness.manager.saveState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://detected.example:8080',
            proxyReachable: true
        });
        const { initializer, published } = createInitializer(harness.manager, harness.extensionContext);

        // A bookkeeping commit (another writer bumping only revision-carrying
        // fields) lands between the patch read and its compare-and-set.
        const realCommit = harness.manager.commitState.bind(harness.manager);
        let commitCalls = 0;
        (harness.manager as unknown as {
            commitState(expected: number, next: ProxyState): Promise<StateCommitResult>;
        }).commitState = async (expected, next) => {
            commitCalls++;
            if (commitCalls === 1) {
                const latest = await harness.manager.getState();
                await harness.manager.saveState({ ...latest, lastTestTimestamp: Date.now() });
            }
            return realCommit(expected, next);
        };

        await initializer.startSystemProxyMonitoring();

        assert.ok(published.length >= 1, 'the monitoring start path must run to its publish');
        assert.strictEqual(harness.persistedState()?.proxyReachable, undefined);
    });

    test('does not start when the mode moved to Off', async () => {
        const harness = createRealStateManager();
        await harness.manager.saveState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://detected.example:8080'
        });
        const { initializer, published } = createInitializer(harness.manager, harness.extensionContext);

        const realCommit = harness.manager.commitState.bind(harness.manager);
        let commitCalls = 0;
        (harness.manager as unknown as {
            commitState(expected: number, next: ProxyState): Promise<StateCommitResult>;
        }).commitState = async (expected, next) => {
            commitCalls++;
            if (commitCalls === 1) {
                const latest = await harness.manager.getState();
                await harness.manager.saveState({ ...latest, mode: ProxyMode.Off });
            }
            return realCommit(expected, next);
        };

        await initializer.startSystemProxyMonitoring();

        assert.deepStrictEqual(published, []);
        assert.strictEqual(
            (SystemProxyDetectionUtils.detectSystemProxySettingsWithSource as sinon.SinonStub).called,
            false,
            'moved to Off: the detection inside monitoring start must not run'
        );
    });

    /**
     * #130: the detection inside a monitoring start can take seconds. A stop
     * that arrives meanwhile finds the monitor not yet active, so the start
     * itself has to notice it and not start the monitor afterwards.
     */
    suite('a stop during the detection of a start (#130)', () => {
        function gateDetection(): { release: () => void; calls: () => number } {
            let release: () => void = () => undefined;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const stub = SystemProxyDetectionUtils.detectSystemProxySettingsWithSource as sinon.SinonStub;
            stub.callsFake(async () => {
                await gate;
                return {
                    proxyUrl: 'http://detected.example:8080',
                    source: 'environment',
                    kind: 'singleProxy',
                    capability: 'supported'
                };
            });
            return { release, calls: () => stub.callCount };
        }

        async function untilDetecting(detection: { calls: () => number }, atLeast: number): Promise<void> {
            for (let turn = 0; turn < 2000 && detection.calls() < atLeast; turn++) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            assert.ok(detection.calls() >= atLeast, 'the start must be waiting in its detection');
        }

        async function startedInAuto() {
            const harness = createRealStateManager();
            await harness.manager.saveState({
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://detected.example:8080'
            });
            const created = createInitializer(harness.manager, harness.extensionContext);
            const monitor = created.initializer.initializeProxyMonitor();
            return { harness, initializer: created.initializer, monitor };
        }

        test('a switch to Off during the detection leaves the monitor stopped', async () => {
            const { harness, initializer, monitor } = await startedInAuto();
            const detection = gateDetection();
            try {
                const starting = initializer.startSystemProxyMonitoring();
                await untilDetecting(detection, 1);

                const current = await harness.manager.getState();
                const off = await harness.manager.commitState(current.revision ?? 0, { ...current, mode: ProxyMode.Off });
                assert.strictEqual(off.kind, 'committed');
                await initializer.stopSystemProxyMonitoring();

                detection.release();
                await starting;

                assert.strictEqual((await harness.manager.getState()).mode, ProxyMode.Off);
                assert.strictEqual(monitor.getState().isActive, false, 'the monitor must not run in Off');
                assert.strictEqual(initializer.isStartupTestStillPending(), false);

                // The next Auto start is a full start: detection runs again.
                const again = await harness.manager.getState();
                await harness.manager.commitState(again.revision ?? 0, { ...again, mode: ProxyMode.Auto });
                const callsBefore = detection.calls();
                await initializer.startSystemProxyMonitoring();
                assert.ok(detection.calls() > callsBefore, 'the next Auto start detects again');
                assert.strictEqual(monitor.getState().isActive, true);
            } finally {
                detection.release();
                monitor.stop();
            }
        });

        test('a stop during the detection is kept even while the mode stays Auto', async () => {
            const { harness, initializer, monitor } = await startedInAuto();
            const detection = gateDetection();
            try {
                const starting = initializer.startSystemProxyMonitoring();
                await untilDetecting(detection, 1);

                // Deactivation stops monitoring without changing the mode.
                await initializer.stopSystemProxyMonitoring();
                detection.release();
                await starting;

                assert.strictEqual((await harness.manager.getState()).mode, ProxyMode.Auto);
                assert.strictEqual(monitor.getState().isActive, false);
                assert.strictEqual(initializer.isStartupTestStillPending(), false);
            } finally {
                detection.release();
                monitor.stop();
            }
        });

        test('a switch to Off whose stop has not arrived yet does not start the monitor', async () => {
            const { harness, initializer, monitor } = await startedInAuto();
            const detection = gateDetection();
            try {
                const starting = initializer.startSystemProxyMonitoring();
                await untilDetecting(detection, 1);

                const current = await harness.manager.getState();
                await harness.manager.commitState(current.revision ?? 0, { ...current, mode: ProxyMode.Off });
                detection.release();
                await starting;

                assert.strictEqual(monitor.getState().isActive, false);
            } finally {
                detection.release();
                monitor.stop();
            }
        });

        test('an undisturbed start still starts the monitor', async () => {
            const { initializer, monitor } = await startedInAuto();
            try {
                await initializer.startSystemProxyMonitoring();
                assert.strictEqual(monitor.getState().isActive, true);
            } finally {
                monitor.stop();
            }
        });
    });
});
