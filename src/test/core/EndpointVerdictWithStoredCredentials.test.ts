/**
 * Auto: OFF for a system proxy whose address has stored credentials (#130).
 *
 * The monitor detects and tests the system proxy without credentials. The
 * state returns the same address with the credentials SecretStorage holds for
 * it (here: from the manual URL). Both name one endpoint, so the monitor's
 * test results and reachability flips must reach the state.
 */
import * as assert from 'assert';
import { handleProxyStateChanged, handleProxyTestComplete } from '../../core/ExtensionProxyEventHandlers';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyMode, ProxyState } from '../../core/types';
import { TestResult } from '../../utils/ProxyUtils';
import { sameProxyEndpoint } from '../../utils/ProxyUrlIdentity';
import { createRealStateManager } from '../realProxyStateManager';

const DETECTED = 'http://proxy.corp.test:8080';
const WITH_CREDENTIALS = 'http://alice:s3cret@proxy.corp.test:8080';

interface Harness {
    context: InitializerContext;
    applies: Array<{ url: string; enabled: boolean }>;
    state: () => Promise<ProxyState>;
}

async function autoWithStoredCredentials(overrides: Partial<ProxyState> = {}): Promise<Harness> {
    const real = createRealStateManager();
    await real.manager.getState();
    await real.manager.saveState({
        mode: ProxyMode.Auto,
        manualProxyUrl: WITH_CREDENTIALS,
        autoProxyUrl: DETECTED,
        autoModeOff: false,
        proxyReachable: true,
        gitConfigured: true,
        npmConfigured: true,
        vscodeConfigured: true,
        ...overrides
    });
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
        sanitizer: { maskPassword: (url: string) => url.replace(/:[^:@/]+@/, ':****@') }
    } as unknown as InitializerContext;
    return { context, applies, state: () => real.manager.getState() };
}

function monitorTest(state: ProxyState, outcome: 'refused' | 'success'): TestResult {
    const refused = outcome === 'refused';
    return {
        success: !refused,
        testUrls: ['https://www.github.com'],
        errors: refused
            ? [{ url: 'https://www.github.com', message: 'connect ECONNREFUSED', failureKind: 'endpointUnreachable' }]
            : [],
        proxyUrl: DETECTED,
        timestamp: Date.now(),
        duration: 5,
        failureKind: refused ? 'endpointUnreachable' : undefined,
        proxyEndpointOk: !refused,
        startedGeneration: captureLogicalGeneration(state)
    } as TestResult;
}

suite('Endpoint verdict with stored credentials (#130)', () => {
    test('precondition: the state returns the detected address with the stored credentials', async () => {
        const harness = await autoWithStoredCredentials();
        assert.strictEqual((await harness.state()).autoProxyUrl, WITH_CREDENTIALS);
    });

    test('a refused test of the detected URL turns Auto: OFF and removes the proxy', async () => {
        const harness = await autoWithStoredCredentials();
        const before = await harness.state();

        await handleProxyTestComplete(harness.context, { isPending: false }, monitorTest(before, 'refused'));

        const after = await harness.state();
        assert.strictEqual(after.autoModeOff, true);
        assert.strictEqual(after.proxyReachable, false);
        assert.strictEqual(after.lastTestResult?.failureKind, 'endpointUnreachable');
        assert.deepStrictEqual(harness.applies, [{ url: '', enabled: false }]);
    });

    test('a reachable-to-unreachable flip of the detected URL turns Auto: OFF', async () => {
        const harness = await autoWithStoredCredentials();

        await handleProxyStateChanged(harness.context, { proxyUrl: DETECTED, reachable: false, previousState: true });

        const after = await harness.state();
        assert.strictEqual(after.autoModeOff, true);
        assert.deepStrictEqual(harness.applies, [{ url: DETECTED, enabled: false }]);
    });

    test('a successful test of the detected URL ends Auto: OFF and applies the stored URL', async () => {
        const harness = await autoWithStoredCredentials({
            autoModeOff: true,
            proxyReachable: false,
            gitConfigured: false,
            npmConfigured: false,
            vscodeConfigured: false
        });
        const before = await harness.state();

        await handleProxyTestComplete(harness.context, { isPending: false }, monitorTest(before, 'success'));

        const after = await harness.state();
        assert.strictEqual(after.autoModeOff, false);
        assert.deepStrictEqual(harness.applies, [{ url: WITH_CREDENTIALS, enabled: true }]);
    });

    test('a test of another address is still left to its proxyChanged event', async () => {
        const harness = await autoWithStoredCredentials();
        const before = await harness.state();
        const other = { ...monitorTest(before, 'refused'), proxyUrl: 'http://other.corp.test:8080' };

        await handleProxyTestComplete(harness.context, { isPending: false }, other);

        const after = await harness.state();
        assert.strictEqual(after.autoModeOff, false);
        assert.strictEqual(after.lastTestResult, undefined);
        assert.deepStrictEqual(harness.applies, []);
    });

    suite('sameProxyEndpoint', () => {
        const rows: Array<[string | undefined, string | undefined, boolean, string]> = [
            [DETECTED, WITH_CREDENTIALS, true, 'credentials on one side only'],
            [WITH_CREDENTIALS, DETECTED, true, 'credentials on the other side only'],
            [DETECTED, 'HTTP://PROXY.corp.test:8080/', true, 'spelling of the same address'],
            [WITH_CREDENTIALS, 'http://alice:s3cret@proxy.corp.test:8080/', true, 'the same credentials'],
            [WITH_CREDENTIALS, 'http://bob:s3cret@proxy.corp.test:8080', false, 'another user'],
            [WITH_CREDENTIALS, 'http://alice:other@proxy.corp.test:8080', false, 'another password'],
            [DETECTED, 'http://proxy.corp.test:3128', false, 'another port'],
            [DETECTED, 'https://proxy.corp.test:8080', false, 'another scheme'],
            [DETECTED, undefined, false, 'a proxy and none'],
            [undefined, '', true, 'no proxy on both sides'],
            ['not a url', 'not a url', true, 'unparsable, same text'],
            ['not a url', 'not a url either', false, 'unparsable, different text']
        ];
        for (const [left, right, expected, name] of rows) {
            test(`${name}: ${expected}`, () => {
                assert.strictEqual(sameProxyEndpoint(left, right), expected);
            });
        }
    });
});
