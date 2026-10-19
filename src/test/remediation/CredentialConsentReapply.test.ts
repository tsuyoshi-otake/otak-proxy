import * as assert from 'assert';
import { ProxyMode, ProxyState } from '../../core/types';
import { reapplyAfterCredentialConsent } from '../../remediation/CredentialConsentReapply';
import { ProxyApplyTrigger } from '../../remediation/ProxyRemediationService';

suite('reapplyAfterCredentialConsent (#108)', () => {
    const URL = 'http://p.example:8080';
    let applies: Array<{ url: string; enabled: boolean; trigger: ProxyApplyTrigger }>;
    let statusBar: ProxyState[];
    let reads: number;

    function run(states: ProxyState[]): Promise<void> {
        return reapplyAfterCredentialConsent({
            getState: async () => states[Math.min(reads++, states.length - 1)],
            getActiveProxyUrl: state => state.autoProxyUrl ?? '',
            applyProxySafely: async (url, enabled, trigger) => {
                applies.push({ url, enabled, trigger });
                return true;
            },
            updateStatusBar: state => { statusBar.push(state); }
        });
    }

    setup(() => {
        applies = [];
        statusBar = [];
        reads = 0;
    });

    test('applies the then-current state once, non-silently, and refreshes the status bar from a fresh read', async () => {
        const waiting: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: URL, applyBlocked: 'credentialConsent' };
        const applied: ProxyState = { mode: ProxyMode.Auto, autoProxyUrl: URL };

        await run([waiting, applied]);

        assert.deepStrictEqual(applies, [{ url: URL, enabled: true, trigger: 'credentialConsent' }]);
        assert.deepStrictEqual(statusBar, [applied]);
    });

    test('uses the URL of the state read now, not the one the prompt was shown for', async () => {
        const moved: ProxyState = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://moved.example:3128',
            applyBlocked: 'credentialConsent'
        };

        await run([moved]);

        assert.strictEqual(applies[0].url, 'http://moved.example:3128');
    });

    test('does nothing once the proxy is Off', async () => {
        await run([{ mode: ProxyMode.Off, applyBlocked: 'credentialConsent' }]);

        assert.deepStrictEqual(applies, []);
        assert.deepStrictEqual(statusBar, []);
    });

    test('does nothing when the marker is gone (applied or cleared in the meantime)', async () => {
        await run([{ mode: ProxyMode.Auto, autoProxyUrl: URL }]);

        assert.deepStrictEqual(applies, []);
    });

    test('does nothing when another block is recorded', async () => {
        await run([{ mode: ProxyMode.Auto, autoProxyUrl: URL, applyBlocked: 'untrustedWorkspace' }]);

        assert.deepStrictEqual(applies, []);
    });

    test('does nothing without an active URL', async () => {
        await run([{ mode: ProxyMode.Auto, applyBlocked: 'credentialConsent' }]);

        assert.deepStrictEqual(applies, []);
    });
});
