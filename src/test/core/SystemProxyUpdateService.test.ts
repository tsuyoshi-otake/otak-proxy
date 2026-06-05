import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SystemProxyUpdateService } from '../../core/SystemProxyUpdateService';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState } from '../../core/types';
import * as DetectUtils from '../../utils/SystemProxyDetectionUtils';

type ConnectionTesterStub = {
    testProxyAuto: sinon.SinonStub;
    [key: string]: unknown;
};

suite('SystemProxyUpdateService Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let state: ProxyState;
    let context: InitializerContext;
    let detectStub: sinon.SinonStub;
    let getConfigStub: sinon.SinonStub;
    let configValues: Record<string, unknown>;
    let connectionTester: ConnectionTesterStub | null;
    let applyProxyStub: sinon.SinonStub;
    let saveStateStub: sinon.SinonStub;
    let notifyStub: sinon.SinonStub;
    let service: SystemProxyUpdateService;

    setup(() => {
        sandbox = sinon.createSandbox();
        state = { mode: ProxyMode.Auto };
        configValues = { enableFallback: true };

        detectStub = sandbox.stub(DetectUtils, 'detectSystemProxySettings');
        getConfigStub = sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string, defaultValue?: unknown) =>
                Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : defaultValue,
            has: () => true,
            inspect: () => undefined,
            update: () => Promise.resolve()
        } as unknown as vscode.WorkspaceConfiguration);

        applyProxyStub = sandbox.stub().resolves(true);
        saveStateStub = sandbox.stub().callsFake(async (next: ProxyState) => {
            state = { ...next };
        });
        notifyStub = sandbox.stub();

        connectionTester = {
            testProxyAuto: sandbox.stub().resolves({
                success: true,
                proxyUrl: '',
                testUrls: [],
                errors: [],
                timestamp: 0
            })
        };

        context = {
            extensionContext: {} as vscode.ExtensionContext,
            proxyStateManager: {
                getState: sandbox.stub().callsFake(async () => ({ ...state })),
                saveState: saveStateStub
            } as unknown as InitializerContext['proxyStateManager'],
            proxyApplier: {
                applyProxy: applyProxyStub
            } as unknown as InitializerContext['proxyApplier'],
            systemProxyDetector: {} as unknown as InitializerContext['systemProxyDetector'],
            userNotifier: {
                showSuccess: notifyStub
            } as unknown as InitializerContext['userNotifier'],
            sanitizer: {
                maskPassword: (url: string) => url
            } as unknown as InitializerContext['sanitizer'],
            proxyChangeLogger: {} as unknown as InitializerContext['proxyChangeLogger']
        };

        service = new SystemProxyUpdateService(context, () => connectionTester as never);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('Auto + detection success: updates state, applies, and notifies', async () => {
        state.mode = ProxyMode.Auto;
        detectStub.resolves('http://detected.example:8080');

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.strictEqual(state.systemProxyDetected, true);
        assert.strictEqual(state.autoModeOff, false);
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        sinon.assert.calledWith(applyProxyStub, 'http://detected.example:8080', true);
        sinon.assert.calledWith(notifyStub, 'message.systemProxyChanged', sinon.match.any);
    });

    test('Auto + detection success + same as before: saves state but does not re-apply or notify', async () => {
        state.mode = ProxyMode.Auto;
        state.autoProxyUrl = 'http://detected.example:8080';
        detectStub.resolves('http://detected.example:8080');

        await service.checkAndUpdateSystemProxy();

        sinon.assert.calledOnce(saveStateStub);
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(notifyStub);
    });

    test('Auto + detection fails + fallback enabled + manual reachable: switches to fallback', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        configValues.enableFallback = true;
        detectStub.resolves(null);
        connectionTester!.testProxyAuto.resolves({
            success: true,
            proxyUrl: 'http://manual.example:3128',
            testUrls: [],
            errors: [],
            timestamp: 0
        });

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, 'http://manual.example:3128');
        assert.strictEqual(state.usingFallbackProxy, true);
        assert.strictEqual(state.fallbackProxyUrl, 'http://manual.example:3128');
        assert.strictEqual(state.autoModeOff, false);
        sinon.assert.calledWith(applyProxyStub, 'http://manual.example:3128', true);
        sinon.assert.calledWith(notifyStub, 'fallback.usingManualProxy', sinon.match.any);
    });

    test('Auto + detection fails + fallback enabled + manual unreachable: enters autoModeOff', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        configValues.enableFallback = true;
        detectStub.resolves(null);
        connectionTester!.testProxyAuto.resolves({
            success: false,
            proxyUrl: 'http://manual.example:3128',
            testUrls: [],
            errors: [{ url: 'https://example.com', message: 'timeout' }],
            timestamp: 0
        });

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
    });

    test('Auto + detection fails + fallback disabled: enters autoModeOff without testing manual', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        configValues.enableFallback = false;
        detectStub.resolves(null);

        await service.checkAndUpdateSystemProxy();

        sinon.assert.notCalled(connectionTester!.testProxyAuto);
        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.usingFallbackProxy, false);
    });

    test('Auto + had detected proxy + detection now null + no fallback: clears and emits systemProxyRemoved', async () => {
        // Covers the message.systemProxyRemoved branch in notifyAutoProxyChange.
        // Prior state had an active autoProxyUrl, neither fallback nor manual
        // can stand in, so the proxy must be cleared and the user notified.
        state.mode = ProxyMode.Auto;
        state.autoProxyUrl = 'http://detected.example:8080';
        configValues.enableFallback = false;
        detectStub.resolves(null);

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        sinon.assert.calledWith(applyProxyStub, '', true);
        sinon.assert.calledWith(notifyStub, 'message.systemProxyRemoved');
    });

    test('Auto + detection fails + no manualProxyUrl: enters autoModeOff', async () => {
        state.mode = ProxyMode.Auto;
        configValues.enableFallback = true;
        detectStub.resolves(null);

        await service.checkAndUpdateSystemProxy();

        sinon.assert.notCalled(connectionTester!.testProxyAuto);
        assert.strictEqual(state.autoProxyUrl, undefined);
        assert.strictEqual(state.autoModeOff, true);
    });

    test('Auto + fallback enabled + connection tester unavailable: treats as unreachable', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        configValues.enableFallback = true;
        detectStub.resolves(null);
        connectionTester = null;

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoModeOff, true);
        assert.strictEqual(state.autoProxyUrl, undefined);
    });

    test('Auto: transition from fallback back to detected proxy clears fallback flags', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        state.autoProxyUrl = 'http://manual.example:3128';
        state.usingFallbackProxy = true;
        state.fallbackProxyUrl = 'http://manual.example:3128';
        detectStub.resolves('http://detected.example:8080');

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        assert.strictEqual(state.usingFallbackProxy, false);
        assert.strictEqual(state.fallbackProxyUrl, undefined);
        sinon.assert.calledWith(applyProxyStub, 'http://detected.example:8080', true);
        sinon.assert.calledWith(notifyStub, 'message.systemProxyChanged', sinon.match.any);
    });

    test('Non-Auto: stale check (within 5min) skips detection when autoProxyUrl present', async () => {
        state.mode = ProxyMode.Manual;
        state.autoProxyUrl = 'http://cached.example:8080';
        state.lastSystemProxyCheck = Date.now() - 60_000;

        await service.checkAndUpdateSystemProxy();

        sinon.assert.notCalled(detectStub);
        sinon.assert.notCalled(saveStateStub);
    });

    test('Non-Auto: stale window expired triggers detection and saves without applying', async () => {
        state.mode = ProxyMode.Manual;
        state.autoProxyUrl = 'http://old.example:8080';
        state.lastSystemProxyCheck = Date.now() - 10 * 60_000;
        detectStub.resolves('http://fresh.example:8080');

        await service.checkAndUpdateSystemProxy();

        sinon.assert.calledOnce(detectStub);
        assert.strictEqual(state.autoProxyUrl, 'http://fresh.example:8080');
        sinon.assert.notCalled(applyProxyStub);
        sinon.assert.notCalled(notifyStub);
    });

    test('Non-Auto + no autoProxyUrl: detection runs even with recent timestamp', async () => {
        state.mode = ProxyMode.Off;
        state.lastSystemProxyCheck = Date.now() - 30_000;
        detectStub.resolves('http://detected.example:8080');

        await service.checkAndUpdateSystemProxy();

        sinon.assert.calledOnce(detectStub);
        assert.strictEqual(state.autoProxyUrl, 'http://detected.example:8080');
        sinon.assert.notCalled(applyProxyStub);
    });

    test('Non-Auto + detection null: stores undefined for autoProxyUrl', async () => {
        state.mode = ProxyMode.Manual;
        state.manualProxyUrl = 'http://manual.example:3128';
        detectStub.resolves(null);

        await service.checkAndUpdateSystemProxy();

        assert.strictEqual(state.autoProxyUrl, undefined);
        sinon.assert.notCalled(applyProxyStub);
    });

    test('getConfiguration is queried with otakProxy scope', async () => {
        state.mode = ProxyMode.Auto;
        state.manualProxyUrl = 'http://manual.example:3128';
        detectStub.resolves(null);

        await service.checkAndUpdateSystemProxy();

        sinon.assert.calledWith(getConfigStub, 'otakProxy');
    });
});
