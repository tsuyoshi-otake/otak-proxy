import * as assert from 'assert';
import { ErrorAggregator } from '../errors/ErrorAggregator';
import { saveProxyConfigResults } from '../core/ProxyConfigStateTracker';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { ProxyMode, ProxyState } from '../core/types';

suite('ProxyConfigStateTracker outcome tests', () => {
    test('persists terminal failure and keeps unavailable optional tools unknown', async () => {
        let state: ProxyState = { mode: ProxyMode.Auto };
        const stateManager = {
            getState: async () => ({ ...state }),
            saveState: async (next: ProxyState) => { state = { ...next }; }
        } as unknown as ProxyStateManager;
        const errors = new ErrorAggregator();
        errors.addError('Terminal environment', 'write failed');

        await saveProxyConfigResults(stateManager, true, {
            gitSuccess: true,
            vscodeSuccess: true,
            npmSuccess: true,
            pipSuccess: true,
            terminalEnvSuccess: false,
            gitOutcome: 'skippedUnavailable',
            vscodeOutcome: 'configured',
            npmOutcome: 'skippedUnavailable',
            pipOutcome: 'skippedUnavailable',
            terminalEnvOutcome: 'failed'
        }, errors);

        assert.strictEqual(state.gitConfigured, undefined);
        assert.strictEqual(state.npmConfigured, undefined);
        assert.strictEqual(state.pipConfigured, undefined);
        assert.strictEqual(state.vscodeConfigured, true);
        assert.strictEqual(state.terminalEnvConfigured, undefined);
        assert.strictEqual(state.targetOutcomes?.git, 'skippedUnavailable');
        assert.strictEqual(state.targetOutcomes?.terminalEnv, 'failed');
        assert.ok(state.lastError?.includes('write failed'));
    });

    test('records preserved external values as not configured by otak-proxy', async () => {
        let state: ProxyState = {
            mode: ProxyMode.Off,
            gitConfigured: true,
            vscodeConfigured: true,
            npmConfigured: true,
            terminalEnvConfigured: true
        };
        const stateManager = {
            getState: async () => ({ ...state }),
            saveState: async (next: ProxyState) => { state = { ...next }; }
        } as unknown as ProxyStateManager;

        await saveProxyConfigResults(stateManager, false, {
            gitSuccess: true,
            vscodeSuccess: true,
            npmSuccess: true,
            terminalEnvSuccess: true,
            gitOutcome: 'preservedExternal',
            vscodeOutcome: 'cleared',
            npmOutcome: 'preservedExternal',
            terminalEnvOutcome: 'cleared'
        }, new ErrorAggregator());

        assert.strictEqual(state.gitConfigured, false);
        assert.strictEqual(state.npmConfigured, false);
        assert.strictEqual(state.vscodeConfigured, false);
        assert.strictEqual(state.terminalEnvConfigured, false);
    });
});
