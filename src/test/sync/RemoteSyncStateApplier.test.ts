import * as assert from 'assert';
import { ProxyMode, ProxyState } from '../../core/types';
import { applyRemoteSyncState, RemoteSyncApplyContext } from '../../sync/RemoteSyncStateApplier';

suite('RemoteSyncStateApplier integration', () => {
    function createContext(applyResult = true) {
        let state: ProxyState = { mode: ProxyMode.Off };
        const calls: Array<{ url: string; enabled: boolean }> = [];
        const monitoring: string[] = [];
        const statuses: ProxyState[] = [];
        const context: RemoteSyncApplyContext = {
            saveState: async next => { state = { ...next }; },
            getState: async () => ({ ...state }),
            getActiveProxyUrl: current => current.mode === ProxyMode.Auto && !current.autoModeOff
                ? current.autoProxyUrl || ''
                : '',
            applyProxy: async (url, enabled) => {
                calls.push({ url, enabled });
                if (!applyResult) {
                    state.lastError = 'sync convergence failed';
                    state.targetOutcomes = { terminalEnv: 'failed' };
                }
                return applyResult;
            },
            startMonitoring: async () => { monitoring.push('start'); },
            stopMonitoring: async () => { monitoring.push('stop'); },
            updateStatus: current => { statuses.push({ ...current }); }
        };
        return { context, calls, monitoring, statuses, getState: () => state };
    }

    test('applies an active Auto proxy and starts monitoring', async () => {
        const fixture = createContext();

        const applied = await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            autoModeOff: false
        }, fixture.context);

        assert.strictEqual(applied, true);
        assert.deepStrictEqual(fixture.calls, [{ url: 'http://proxy.example:8080', enabled: true }]);
        assert.deepStrictEqual(fixture.monitoring, ['start']);
    });

    test('treats synchronized Auto OFF as a real local disable and keeps monitoring', async () => {
        const fixture = createContext();

        await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            autoModeOff: true
        }, fixture.context);

        assert.deepStrictEqual(fixture.calls, [{ url: '', enabled: false }]);
        assert.deepStrictEqual(fixture.monitoring, ['start']);
        assert.strictEqual(fixture.getState().autoModeOff, true);
    });

    test('disables explicit Off and stops monitoring', async () => {
        const fixture = createContext();

        await applyRemoteSyncState({ mode: ProxyMode.Off }, fixture.context);

        assert.deepStrictEqual(fixture.calls, [{ url: '', enabled: false }]);
        assert.deepStrictEqual(fixture.monitoring, ['stop']);
    });

    test('returns failure and presents the post-apply degraded state', async () => {
        const fixture = createContext(false);
        let failureNotifications = 0;
        fixture.context.onApplyFailure = () => failureNotifications++;

        const applied = await applyRemoteSyncState({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080'
        }, fixture.context);

        assert.strictEqual(applied, false);
        assert.strictEqual(failureNotifications, 1);
        assert.strictEqual(fixture.statuses.length, 1);
        assert.strictEqual(fixture.statuses[0].lastError, 'sync convergence failed');
        assert.strictEqual(fixture.statuses[0].targetOutcomes?.terminalEnv, 'failed');
    });
});
