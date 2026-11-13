/**
 * A change between "no proxy", PAC and WPAD is a proxy change (#130).
 *
 * None of the three has a proxy URL or split routing, so comparing those alone
 * reported nothing: the state kept saying PAC, and the proxy applied before
 * the PAC stayed applied, after the OS proxy settings were removed.
 */
import * as assert from 'assert';
import { handleProxyChanged } from '../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../core/ExtensionInitializerTypes';
import { captureLogicalGeneration } from '../core/LogicalGeneration';
import { ProxyMode, ProxyState } from '../core/types';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { ProxyMonitor } from '../monitoring/ProxyMonitor';
import { ProxyDetectionResult, ProxyMonitorConfig } from '../monitoring/ProxyMonitorTypes';
import { InputSanitizer } from '../validation/InputSanitizer';
import { createRealStateManager } from './realProxyStateManager';

const X = 'http://proxy.corp.test:8080';

type Detection = Pick<ProxyDetectionResult, 'proxyUrl' | 'source' | 'kind' | 'capability' | 'httpUrl' | 'httpsUrl'>;

const PROXY_X: Detection = { proxyUrl: X, source: 'windows', kind: 'singleProxy', capability: 'supported', httpUrl: X, httpsUrl: X };
const PAC: Detection = { proxyUrl: null, source: 'windows', kind: 'pac', capability: 'unsupported' };
const WPAD: Detection = { proxyUrl: null, source: 'windows', kind: 'wpad', capability: 'unsupported' };
const DIRECT: Detection = { proxyUrl: null, source: null, kind: 'direct', capability: 'supported' };

interface MonitorHarness {
    /** One monitor check that detects `detection`; resolves after its handlers ran. */
    check(detection: Detection): Promise<void>;
    /** The `kind` of each proxyChanged event since the last call. */
    takeChanges(): Array<string | undefined>;
    applies: Array<{ url: string; enabled: boolean }>;
    state(): Promise<ProxyState>;
}

async function createHarness(initial: ProxyState): Promise<MonitorHarness> {
    const real = createRealStateManager();
    await real.manager.getState();
    await real.manager.saveState(initial);

    const applies: Array<{ url: string; enabled: boolean }> = [];
    const context = {
        proxyStateManager: real.manager,
        publishProxyState: async () => undefined,
        applyProxySettings: async (url: string, enabled: boolean) => {
            applies.push({ url, enabled });
            return true;
        },
        updateStatusBar: () => undefined,
        userNotifier: { showSuccess: () => undefined, showWarning: () => undefined },
        sanitizer: new InputSanitizer()
    } as unknown as InitializerContext;

    let next: Detection = DIRECT;
    const monitor = new ProxyMonitor(
        {
            detectSystemProxy: async () => next.proxyUrl,
            detectSystemProxyWithSource: async () => next
        } as never,
        new ProxyChangeLogger(new InputSanitizer()),
        { maxRetries: 0, debounceDelay: 10, enableConnectionTest: false } as Partial<ProxyMonitorConfig> as never
    );
    let changes: Array<string | undefined> = [];
    let queue: Promise<void> = Promise.resolve();
    monitor.on('proxyChanged', (result: ProxyDetectionResult) => {
        changes.push(result.kind);
        queue = queue.then(async () => {
            if (await handleProxyChanged(context, result) === 'notAdopted') {
                monitor.proxyChangeNotAdopted(result);
            }
        });
    });
    monitor.setGenerationCapture(async () => captureLogicalGeneration(await real.manager.getState()));

    return {
        check: async detection => {
            next = detection;
            await (monitor as unknown as { executeCheck(trigger: string): Promise<unknown> }).executeCheck('polling');
            await queue;
        },
        takeChanges: () => {
            const taken = changes;
            changes = [];
            return taken;
        },
        applies,
        state: () => real.manager.getState()
    };
}

function autoState(overrides: Partial<ProxyState> = {}): ProxyState {
    return {
        mode: ProxyMode.Auto,
        autoModeOff: false,
        gitConfigured: true,
        npmConfigured: true,
        vscodeConfigured: true,
        ...overrides
    };
}

suite('ProxyMonitor: PAC, WPAD and no proxy are different detections (#130)', () => {
    test('proxy, then PAC, then no proxy: the removal is reported and the proxy is removed', async () => {
        const harness = await createHarness(autoState({
            autoProxyUrl: X,
            proxyReachable: true,
            lastDetectionKind: 'singleProxy'
        }));

        await harness.check(PROXY_X);
        await harness.check(PAC);
        assert.strictEqual((await harness.state()).lastDetectionKind, 'pac');
        harness.takeChanges();
        const appliesBefore = harness.applies.length;

        await harness.check(DIRECT);

        assert.deepStrictEqual(harness.takeChanges(), ['direct']);
        const after = await harness.state();
        assert.strictEqual(after.lastDetectionKind, 'direct');
        assert.strictEqual(after.lastDetectionCapability, 'supported');
        assert.strictEqual(after.autoProxyUrl, undefined);
        assert.deepStrictEqual(harness.applies.slice(appliesBefore), [{ url: '', enabled: false }]);
    });

    test('no proxy, then PAC: the PAC is reported', async () => {
        const harness = await createHarness(autoState({ lastDetectionKind: 'direct' }));

        await harness.check(DIRECT);
        harness.takeChanges();
        await harness.check(PAC);

        assert.deepStrictEqual(harness.takeChanges(), ['pac']);
        const after = await harness.state();
        assert.strictEqual(after.lastDetectionKind, 'pac');
        assert.strictEqual(after.lastDetectionCapability, 'unsupported');
    });

    test('PAC, then WPAD: the change of kind is reported', async () => {
        const harness = await createHarness(autoState({ lastDetectionKind: 'direct' }));

        await harness.check(PAC);
        harness.takeChanges();
        await harness.check(WPAD);

        assert.deepStrictEqual(harness.takeChanges(), ['wpad']);
        assert.strictEqual((await harness.state()).lastDetectionKind, 'wpad');
    });

    test('the same detection twice is reported once', async () => {
        for (const detection of [PAC, WPAD, DIRECT, PROXY_X]) {
            const harness = await createHarness(autoState({ lastDetectionKind: 'direct' }));
            await harness.check(detection);
            harness.takeChanges();
            await harness.check(detection);
            assert.deepStrictEqual(harness.takeChanges(), [], `repeated ${detection.kind}`);
        }
    });

    test('the first detection after start is not reported for its kind alone', async () => {
        // The start path (startup, switch to Auto) has handled it already.
        for (const detection of [PAC, WPAD, DIRECT]) {
            const harness = await createHarness(autoState({ lastDetectionKind: detection.kind }));
            await harness.check(detection);
            assert.deepStrictEqual(harness.takeChanges(), [], `first ${detection.kind}`);
        }
    });
});
