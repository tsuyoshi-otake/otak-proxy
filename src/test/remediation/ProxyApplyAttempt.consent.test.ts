import * as assert from 'assert';
import { ProxyApplyDetailedResult } from '../../core/ProxyApplierTypes';
import { ProxyMode, ProxyState, stateRevision } from '../../core/types';
import { runProxyApplyAttempt } from '../../remediation/ProxyApplyAttempt';
import { CredentialConsentRequest } from '../../remediation/ProxyRemediationService';
import { UNRESOLVED_LOCAL_CREDENTIAL_ERROR } from '../../utils/ProxyStateSanitizer';

/**
 * The attempt owns the order "marker first, then prompt, never awaited" for a
 * plan the service stopped at `consentRequired` (#108). The service is a stub
 * here; the real one is driven in CredentialConsentAllUrls.test.ts.
 */
suite('runProxyApplyAttempt credential consent (#108)', () => {
    const URL = 'http://p.example:8080';
    const REQUEST: CredentialConsentRequest = { keys: ['key-a', 'key-b'] };

    let stored: ProxyState;
    let log: string[];

    function writer(options: { supersedeOnCommit?: boolean } = {}) {
        return {
            getState: async (): Promise<ProxyState> => ({ ...stored }),
            saveState: async (next: ProxyState) => { stored = { ...next }; },
            commitState: async (expected: number, next: ProxyState) => {
                if (options.supersedeOnCommit || stateRevision(stored) !== expected) {
                    return { kind: 'superseded', current: { ...stored } } as const;
                }
                log.push(`commit applyBlocked=${String(next.applyBlocked)}`);
                stored = { ...next, revision: expected + 1 };
                return { kind: 'committed', revision: expected + 1, state: { ...stored } } as const;
            }
        };
    }

    function service(stopReason: string, request: CredentialConsentRequest | undefined) {
        return {
            applyWithSafety: async () => ({
                success: false,
                retryAttempted: false,
                retrySuppressed: false,
                lockSkipped: false,
                lockIoError: false,
                outcome: { stopReason },
                consentRequest: request
            }),
            startCredentialConsentPrompt: (received: CredentialConsentRequest) => {
                log.push(`prompt ${received.keys.join(',')}`);
            }
        };
    }

    async function attempt(
        remediation: ReturnType<typeof service>,
        stateWriter: ReturnType<typeof writer>,
        options?: { silent?: boolean }
    ) {
        return runProxyApplyAttempt(
            stateWriter,
            async (url, enabled): Promise<ProxyApplyDetailedResult> => ({
                success: true,
                enabled,
                proxyUrl: url,
                results: { gitSuccess: true, vscodeSuccess: true, npmSuccess: true, terminalEnvSuccess: true },
                errors: []
            }),
            remediation as never,
            URL,
            true,
            'autoDetection',
            options
        );
    }

    setup(() => {
        stored = { mode: ProxyMode.Auto, autoProxyUrl: URL, revision: 1 };
        log = [];
    });

    test('commits the blocked marker, then starts the prompt', async () => {
        const result = await attempt(service('consentRequired', REQUEST), writer());

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.stopReason, 'consentRequired');
        assert.deepStrictEqual(log, ['commit applyBlocked=credentialConsent', 'prompt key-a,key-b']);
        assert.strictEqual(stored.applyBlocked, 'credentialConsent');
    });

    test('a silent attempt commits the marker but never prompts', async () => {
        await attempt(service('consentRequired', REQUEST), writer(), { silent: true });

        assert.deepStrictEqual(log, ['commit applyBlocked=credentialConsent']);
    });

    test('a stale generation neither marks nor prompts', async () => {
        await attempt(service('consentRequired', REQUEST), writer({ supersedeOnCommit: true }));

        assert.deepStrictEqual(log, []);
        assert.strictEqual(stored.applyBlocked, undefined);
    });

    test('blocked by policy marks the state but there is nothing to ask', async () => {
        await attempt(service('consentRequired', undefined), writer());

        assert.deepStrictEqual(log, ['commit applyBlocked=credentialConsent']);
    });

    test('another stop reason neither marks nor prompts', async () => {
        await attempt(service('lockSkipped', undefined), writer());

        assert.deepStrictEqual(log, []);
        assert.strictEqual(stored.applyBlocked, undefined);
    });

    test('the credential gate refuses before the service, with no marker and no prompt', async () => {
        stored = {
            mode: ProxyMode.Auto,
            autoProxyUrl: URL,
            authRequiredProxyUrls: ['http://p.example:8080/'],
            requiresAuth: true,
            revision: 1
        };
        let serviceCalls = 0;
        const refusing = service('consentRequired', REQUEST);
        const counting = {
            ...refusing,
            applyWithSafety: async () => {
                serviceCalls++;
                return refusing.applyWithSafety();
            }
        };

        const result = await attempt(counting, writer());

        assert.strictEqual(result.success, false);
        assert.strictEqual(serviceCalls, 0);
        assert.deepStrictEqual(log, ['commit applyBlocked=undefined']);
        assert.strictEqual(stored.applyBlocked, undefined);
        assert.strictEqual(stored.lastError, UNRESOLVED_LOCAL_CREDENTIAL_ERROR);
    });
});
