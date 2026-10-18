/**
 * #78: the toggle must commit the desired mode before applying it, through the
 * real ProxyStateManager (hydration, migrateManualModeToAuto, revision-checked
 * commitState) and an applier that commits its per-target results (revision +1)
 * the way ProxyApplier -> saveProxyConfigResults does. Stub contexts that never
 * advance the revision shipped the "mode never saved" defect through
 * v3.2.7-v3.2.16, so this suite drives the real protocol.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { executeToggleProxy } from '../../commands/ToggleProxyCommand';
import { CommandContext } from '../../commands/types';
import { createFencedApply } from '../../core/GenerationFence';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyApplyDetailedResult, ProxyConfigResults } from '../../core/ProxyApplierTypes';
import { saveProxyConfigResults } from '../../core/ProxyConfigStateTracker';
import { ProxyStateManager } from '../../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../../core/types';
import { ErrorAggregator } from '../../errors/ErrorAggregator';
import { I18nManager } from '../../i18n/I18nManager';

suite('ToggleProxyCommand commits the desired mode before apply (#78)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        I18nManager.getInstance().initialize('en');
        sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (_key: string, defaultValue?: unknown) => defaultValue,
            update: () => Promise.resolve(),
            has: () => true,
            inspect: () => undefined
        } as unknown as vscode.WorkspaceConfiguration);
    });

    teardown(() => {
        sandbox.restore();
    });

    interface Harness {
        ctx: CommandContext;
        state: () => Promise<ProxyState>;
        events: string[];
        applies: Array<{ url: string; enabled: boolean }>;
        /** Mode the diagnostics path would see during each apply. */
        modeAtApply: ProxyMode[];
        published: ProxyState[];
        /** An interleaved writer to run inside the next commitState call(s). */
        queuedCommitWrites: Array<() => Promise<void>>;
        duringApply: (writer: () => Promise<void>) => void;
    }

    /** Fake ExtensionContext wired like ProxyStateManager.test.ts: map-backed
     *  globalState and secrets. */
    function fakeExtensionContext(): { context: vscode.ExtensionContext; globalState: Map<string, unknown> } {
        const globalState = new Map<string, unknown>();
        const secrets = new Map<string, string>();
        const context = {
            globalState: {
                get: (key: string, defaultValue?: unknown) =>
                    globalState.has(key) ? globalState.get(key) : defaultValue,
                update: async (key: string, value: unknown) => { globalState.set(key, value); },
                keys: () => [...globalState.keys()],
                setKeysForSync: () => {}
            },
            subscriptions: [],
            extensionPath: '',
            storagePath: undefined,
            globalStoragePath: '',
            logPath: '',
            extensionUri: vscode.Uri.file(''),
            environmentVariableCollection: {} as vscode.EnvironmentVariableCollection,
            extensionMode: vscode.ExtensionMode.Test,
            storageUri: undefined,
            globalStorageUri: vscode.Uri.file(''),
            logUri: vscode.Uri.file(''),
            asAbsolutePath: (relativePath: string) => relativePath,
            workspaceState: {} as vscode.Memento,
            secrets: {
                get: async (key: string) => secrets.get(key),
                store: async (key: string, value: string) => { secrets.set(key, value); },
                delete: async (key: string) => { secrets.delete(key); },
                onDidChange: () => ({ dispose: () => {} })
            } as unknown as vscode.SecretStorage,
            extension: {} as vscode.Extension<unknown>,
            languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation
        } as unknown as vscode.ExtensionContext;
        return { context, globalState };
    }

    function harness(
        initial: ProxyState,
        options?: { detectedUrl?: string; detectedFields?: Partial<ProxyState> }
    ): Harness {
        const { context, globalState } = fakeExtensionContext();
        globalState.set('proxyState', { revision: 1, ...initial });
        const stateManager = new ProxyStateManager(context);

        const events: string[] = [];
        const applies: Array<{ url: string; enabled: boolean }> = [];
        const modeAtApply: ProxyMode[] = [];
        const published: ProxyState[] = [];
        const queuedCommitWrites: Array<() => Promise<void>> = [];
        let duringApplyWriter: (() => Promise<void>) | undefined;

        // Mirrors ProxyApplier.applyProxyDetailed -> saveProxyConfigResults:
        // captures its own generation, writes targets, commits results
        // (revision +1) through the real revision-checked manager.
        const realApply = async (proxyUrl: string, enabled: boolean): Promise<ProxyApplyDetailedResult> => {
            const generation = captureLogicalGeneration(await stateManager.getState());
            modeAtApply.push((await stateManager.getState()).mode);
            const writer = duringApplyWriter;
            duringApplyWriter = undefined;
            await writer?.();
            const results: ProxyConfigResults = {
                gitSuccess: true,
                vscodeSuccess: true,
                npmSuccess: true,
                terminalEnvSuccess: true,
                gitOutcome: enabled ? 'configured' : 'cleared',
                vscodeOutcome: enabled ? 'configured' : 'cleared',
                npmOutcome: enabled ? 'configured' : 'cleared',
                terminalEnvOutcome: enabled ? 'configured' : 'cleared'
            };
            const committedRevision = await saveProxyConfigResults(
                stateManager, enabled, results, new ErrorAggregator(), generation
            );
            return { success: true, enabled, proxyUrl, results, errors: [], committedRevision };
        };

        const h: Harness = {
            ctx: {
                extensionContext: context,
                getProxyState: () => stateManager.getState(),
                saveProxyState: async next => { await stateManager.saveState(next); },
                commitProxyState: async (expected, next) => {
                    await queuedCommitWrites.shift()?.();
                    const result = await stateManager.commitState(expected, next);
                    if (result.kind === 'committed') {
                        events.push('commit');
                    }
                    return result;
                },
                publishProxyState: async next => {
                    events.push('publish');
                    published.push({ ...next });
                },
                getActiveProxyUrl: s => stateManager.getActiveProxyUrl(s),
                getNextMode: m => stateManager.getNextMode(m),
                applyProxySettings: async (url, enabled) => {
                    events.push('apply');
                    applies.push({ url, enabled });
                    // Same fence wiring as extension.ts applyProxySafely.
                    const apply = createFencedApply(
                        stateManager,
                        captureLogicalGeneration(await stateManager.getState()),
                        'manual',
                        realApply
                    );
                    return (await apply(url, enabled)).success;
                },
                updateStatusBar: () => { events.push('statusBar'); },
                checkAndUpdateSystemProxy: async () => {
                    if (!options?.detectedUrl) {
                        return;
                    }
                    // The detection path committing under the toggle is the
                    // benign revision/test-field writer the CAS loop must fold
                    // over without reverting the fields it owns.
                    await stateManager.saveState({
                        ...(await stateManager.getState()),
                        autoProxyUrl: options.detectedUrl,
                        systemProxyDetected: true,
                        lastDetectionSource: 'windows',
                        ...options.detectedFields
                    });
                },
                startSystemProxyMonitoring: async () => { events.push('monitorStart'); },
                stopSystemProxyMonitoring: async () => { events.push('monitorStop'); },
                userNotifier: {
                    showSuccess: () => {},
                    showWarning: () => {},
                    showError: () => {},
                    showErrorWithDetails: async () => {},
                    showProgressNotification: async (_title, task) =>
                        task({ report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>)
                },
                sanitizer: { maskPassword: url => url }
            },
            state: () => stateManager.getState(),
            events,
            applies,
            modeAtApply,
            published,
            queuedCommitWrites,
            duringApply: writer => { duringApplyWriter = writer; }
        };
        return h;
    }

    test('Off -> Auto with a detected proxy saves mode auto and publishes after the apply', async () => {
        const h = harness({ mode: ProxyMode.Off }, { detectedUrl: 'http://proxy.example.com:8080' });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto, 'saved mode must be auto');
        assert.strictEqual(state.convergencePending, false);
        assert.deepStrictEqual(h.applies, [{ url: 'http://proxy.example.com:8080', enabled: true }]);
        assert.strictEqual(h.events.filter(e => e === 'monitorStart').length, 1);
        assert.strictEqual(h.published.length, 1);
        assert.strictEqual(h.published[0].mode, ProxyMode.Auto);
        // commit < apply < monitorStart < publish: the mode is stored before
        // the apply, and the monitor starts only afterwards.
        const order = ['commit', 'apply', 'monitorStart', 'publish'].map(e => h.events.indexOf(e));
        assert.ok(order.every((index, i) => index >= 0 && (i === 0 || order[i - 1] < index)),
            `expected commit < apply < monitorStart < publish, got ${h.events.join(',')}`);
    });

    test('diagnostics inside the apply read the committed (new) mode, so Off -> Auto reports no residual', async () => {
        const h = harness({ mode: ProxyMode.Off }, { detectedUrl: 'http://proxy.example.com:8080' });

        await executeToggleProxy(h.ctx);

        assert.deepStrictEqual(h.modeAtApply, [ProxyMode.Auto]);
        assert.strictEqual(h.applies.length, 1, 'no convergence retry');
    });

    test('Auto -> Off saves mode off and stops monitoring before the unset apply', async () => {
        const h = harness({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example.com:8080' });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.strictEqual(state.convergencePending, false);
        assert.deepStrictEqual(h.applies, [{ url: '', enabled: false }]);
        const order = ['commit', 'monitorStop', 'apply', 'publish'].map(e => h.events.indexOf(e));
        assert.ok(order.every((index, i) => index >= 0 && (i === 0 || order[i - 1] < index)),
            `expected commit < monitorStop < apply < publish, got ${h.events.join(',')}`);
        assert.strictEqual(h.published[0].mode, ProxyMode.Off);
    });

    test('Off -> Auto with nothing detected and no fallback saves mode auto with autoModeOff', async () => {
        const h = harness({ mode: ProxyMode.Off });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoModeOff, true);
        assert.deepStrictEqual(h.applies, [{ url: '', enabled: false }]);
        assert.strictEqual(h.published.at(-1)?.mode, ProxyMode.Auto);
        // Auto: OFF keeps monitoring (it detects the proxy returning), started after apply.
        const order = [h.events.indexOf('apply'), h.events.indexOf('monitorStart')];
        assert.ok(order[0] >= 0 && order[0] < order[1]);
    });

    test('another writer changing the mode before the commit supersedes the toggle', async () => {
        const h = harness({ mode: ProxyMode.Off }, { detectedUrl: 'http://proxy.example.com:8080' });
        h.queuedCommitWrites.push(async () => {
            // A sync toggle landed between the read and the compare-and-set.
            await h.ctx.saveProxyState({
                ...(await h.state()),
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://other.example.com:9090'
            });
        });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(h.applies.length, 0, 'superseded toggle must not apply');
        assert.strictEqual(h.published.length, 0, 'superseded toggle must not publish');
        assert.strictEqual(state.mode, ProxyMode.Auto);
        assert.strictEqual(state.autoProxyUrl, 'http://other.example.com:9090');
    });

    test('a mode change during the apply keeps the toggle from clearing or publishing', async () => {
        const h = harness({ mode: ProxyMode.Off }, { detectedUrl: 'http://proxy.example.com:8080' });
        h.duringApply(async () => {
            await h.ctx.saveProxyState({ ...(await h.state()), mode: ProxyMode.Off });
        });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(h.applies.length, 1);
        assert.strictEqual(h.published.length, 0, 'another identity owns the state now');
        assert.strictEqual(state.mode, ProxyMode.Off);
    });

    test('revision/test-field-only writers during commit and apply do not drop the toggle', async () => {
        const h = harness({ mode: ProxyMode.Off }, { detectedUrl: 'http://proxy.example.com:8080' });
        // First CAS attempt loses to a benign writer that only bumps the revision.
        h.queuedCommitWrites.push(async () => {
            await h.ctx.saveProxyState({
                ...(await h.state()),
                lastTestTimestamp: Date.now(),
                lastTestResult: { success: true, testUrls: [], errors: [], proxyUrl: 'http://proxy.example.com:8080' } as never
            });
        });
        // And during the apply another revision-only write lands (apply-result
        // churn for a finished write, monitor commit).
        h.duringApply(async () => {
            await h.ctx.saveProxyState({ ...(await h.state()), lastTestTimestamp: Date.now() + 1 });
        });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto, 'the toggle still lands its mode');
        assert.strictEqual(state.convergencePending, false);
        assert.strictEqual(h.published.length, 1);
        assert.strictEqual(h.published[0].mode, ProxyMode.Auto);
        assert.ok(h.events.filter(e => e === 'commit').length >= 2, 'the CAS loop retried the fold');
    });

    test('Off -> Auto keeps the per-scheme fields detection committed under the snapshot', async () => {
        const h = harness(
            {
                mode: ProxyMode.Off,
                autoProxyKind: 'singleProxy',
                autoHttpProxyUrl: 'http://stale.example:1',
                autoHttpsProxyUrl: 'http://stale.example:2',
                detectedBypass: 'stale-bypass',
                lastDetectionKind: 'singleProxy'
            },
            {
                detectedUrl: 'http://proxy.example.com:8080',
                detectedFields: {
                    autoProxyKind: 'perSchemeProxy',
                    autoHttpProxyUrl: 'http://fresh.example:8080',
                    autoHttpsProxyUrl: 'https://fresh.example:8443',
                    detectedBypass: 'fresh-bypass',
                    lastDetectionKind: 'perSchemeProxy'
                }
            }
        );

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Auto);
        // Detection owns these fields; the pre-toggle snapshot must not roll
        // them back when the desired state is committed.
        assert.strictEqual(state.autoProxyKind, 'perSchemeProxy');
        assert.strictEqual(state.autoHttpProxyUrl, 'http://fresh.example:8080');
        assert.strictEqual(state.autoHttpsProxyUrl, 'https://fresh.example:8443');
        assert.strictEqual(state.detectedBypass, 'fresh-bypass');
        assert.strictEqual(state.lastDetectionKind, 'perSchemeProxy');
    });

    test('Auto -> Off keeps a newer test result committed between snapshot and CAS', async () => {
        const h = harness({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example.com:8080',
            lastTestResult: { success: true, testUrls: [], errors: [] } as never,
            lastTestTimestamp: 1000,
            proxyReachable: true
        });
        const newerTestResult = { success: false, testUrls: [], errors: [{ url: '', message: 'timeout' }] };
        const newerTimestamp = Date.now() + 5000;
        // A monitor test result lands between the pre-toggle snapshot and the
        // toggle's compare-and-set: the CAS fails once, then retries.
        h.queuedCommitWrites.push(async () => {
            await h.ctx.saveProxyState({
                ...(await h.state()),
                lastTestResult: newerTestResult as never,
                lastTestTimestamp: newerTimestamp,
                proxyReachable: false
            });
        });

        const result = await executeToggleProxy(h.ctx);
        const state = await h.state();

        assert.strictEqual(result.success, true);
        assert.strictEqual(state.mode, ProxyMode.Off);
        assert.deepStrictEqual(state.lastTestResult, newerTestResult);
        assert.strictEqual(state.lastTestTimestamp, newerTimestamp);
        assert.strictEqual(state.proxyReachable, false);
    });
});
