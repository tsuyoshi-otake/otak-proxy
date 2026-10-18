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
            systemProxyDetector: {},
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
});
