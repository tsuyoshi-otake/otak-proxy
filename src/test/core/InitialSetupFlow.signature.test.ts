/**
 * #78: the initial-setup prompt compares a signature captured before the
 * prompt with the state after the answer. The concurrent startup apply commits
 * its results while the prompt is open (revision +1, same identity), which used
 * to discard every answer.
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { InitialSetupFlow } from '../../core/InitialSetupFlow';
import { InitializerContext } from '../../core/ExtensionInitializerTypes';
import { ProxyMode, ProxyState, stateRevision } from '../../core/types';
import { I18nManager } from '../../i18n/I18nManager';
import { InputSanitizer } from '../../validation/InputSanitizer';

suite('InitialSetupFlow answer survives a revision-only commit (#78)', () => {
    let sandbox: sinon.SinonSandbox;
    let i18n: I18nManager;

    setup(() => {
        sandbox = sinon.createSandbox();
        i18n = I18nManager.getInstance();
        i18n.initialize('en');
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
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

    function harness() {
        let stored: ProxyState = { revision: 1, mode: ProxyMode.Off };
        const applies: Array<{ url: string; enabled: boolean }> = [];
        const notifications: string[] = [];

        const context = {
            extensionContext: {} as vscode.ExtensionContext,
            proxyStateManager: {
                getState: async () => ({ ...stored }),
                saveState: async (next: ProxyState) => {
                    stored = { ...next, revision: stateRevision(stored) + 1 };
                }
            },
            proxyApplier: {} as never,
            applyProxySettings: async (url: string, enabled: boolean) => {
                applies.push({ url, enabled });
                return true;
            },
            systemProxyDetector: {} as never,
            userNotifier: {
                showSuccess: (key: string) => { notifications.push(key); },
                showWarning: () => {},
                showError: (key: string) => { notifications.push(key); }
            } as never,
            sanitizer: new InputSanitizer(),
            proxyChangeLogger: {} as never,
            updateStatusBar: () => {}
        } as unknown as InitializerContext;

        return {
            context,
            applies,
            notifications,
            state: () => stored,
            /** The startup apply committing while the prompt is open. */
            write: (change: (current: ProxyState) => ProxyState) =>
                (context.proxyStateManager.saveState as (s: ProxyState) => Promise<void>)(
                    change({ ...stored })
                )
        };
    }

    test('the answer is applied when only the revision moved while the prompt was open', async () => {
        const h = harness();
        const flow = new InitialSetupFlow(h.context, async () => {});
        (sandbox.stub(vscode.window, 'showInformationMessage') as sinon.SinonStub)
            .resolves(i18n.t('action.manualSetup'));
        (sandbox.stub(vscode.window, 'showInputBox') as sinon.SinonStub).callsFake(async () => {
            // A revision-only commit (the startup apply's result bookkeeping).
            await h.write(current => current);
            return 'http://manual.example:3128';
        });

        await flow.askForInitialSetup();

        assert.strictEqual(h.state().manualProxyUrl, 'http://manual.example:3128');
        assert.strictEqual(h.state().mode, ProxyMode.Auto);
        assert.deepStrictEqual(h.applies, [{ url: 'http://manual.example:3128', enabled: true }]);
    });

    test('the answer is discarded when the mode changed while the prompt was open', async () => {
        const h = harness();
        const flow = new InitialSetupFlow(h.context, async () => {});
        (sandbox.stub(vscode.window, 'showInformationMessage') as sinon.SinonStub)
            .resolves(i18n.t('action.manualSetup'));
        (sandbox.stub(vscode.window, 'showInputBox') as sinon.SinonStub).callsFake(async () => {
            // A real change: another window toggled to Auto while we waited.
            await h.write(current => ({
                ...current,
                mode: ProxyMode.Auto,
                autoProxyUrl: 'http://other.example:9090'
            }));
            return 'http://manual.example:3128';
        });

        await flow.askForInitialSetup();

        assert.strictEqual(h.state().manualProxyUrl, undefined, 'the answer must not overwrite the newer state');
        assert.strictEqual(h.state().mode, ProxyMode.Auto);
        assert.strictEqual(h.applies.length, 0);
    });
});
