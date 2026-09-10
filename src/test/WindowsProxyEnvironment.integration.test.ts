import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { startWindowsProxyEnvironmentNotification } from '../monitoring/WindowsProxyEnvironmentNotification';
import {
    parseWindowsProxyEnvironment, readWindowsProxyEnvironment,
    WindowsProxyEnvironmentMonitor, WindowsProxyEnvironmentSnapshot
} from '../monitoring/WindowsProxyEnvironment';

suite('WindowsProxyEnvironment integration', () => {
    let sandbox: sinon.SinonSandbox;
    let monitor: WindowsProxyEnvironmentMonitor | undefined;
    let warning: sinon.SinonStub;
    let saved: WindowsProxyEnvironmentSnapshot;
    let read: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        sandbox.stub(vscode.window, 'state').value({ focused: true });
        sandbox.stub(vscode.env, 'remoteName').value(undefined);
        const empty = { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null };
        saved = { user: { ...empty }, machine: { ...empty } };
        saved.user.HTTP_PROXY = 'http://notification-user:notification-secret@notify.invalid:9080';
        saved.machine.NO_PROXY = 'notification-only.invalid';
        read = sandbox.stub().callsFake(async () => parseWindowsProxyEnvironment(JSON.stringify(saved)));
        I18nManager.getInstance().initialize('ja');
    });
    teardown(() => { monitor?.dispose(); monitor = undefined; sandbox.restore(); });

    test('local Windows notifies variable names in Japanese without credentials or changing detection', async () => {
        sandbox.stub(process, 'platform').value('win32');
        const detector = new SystemProxyDetector(['environment']);
        const before = await detector.detectSystemProxyWithSource();
        monitor = startWindowsProxyEnvironmentNotification(read);
        assert.ok(monitor);
        await monitor.check();
        assert.strictEqual(warning.callCount, 1);
        const message = warning.firstCall.args[0] as string;
        assert.ok(message.includes('HTTP_PROXY'));
        assert.ok(message.includes('NO_PROXY'));
        assert.ok(message.includes('完全に終了'));
        assert.ok(!message.includes('notification-secret'));
        assert.ok(!message.includes('notify.invalid'));
        assert.deepStrictEqual(await detector.detectSystemProxyWithSource(), before);
        await monitor.check();
        assert.strictEqual(warning.callCount, 1);
    });

    test('unavailable tool produces no false notification and successful retry recovers', async () => {
        sandbox.stub(process, 'platform').value('win32');
        read.onFirstCall().rejects(Object.assign(new Error('tool unavailable'), { code: 'ENOENT' }));
        monitor = startWindowsProxyEnvironmentNotification(read);
        assert.ok(monitor);
        await monitor.check();
        assert.strictEqual(warning.callCount, 0);
        await monitor.check();
        assert.strictEqual(warning.callCount, 1);
    });

    test('notification dismissal does not block a subsequent read or disposal', async () => {
        sandbox.stub(process, 'platform').value('win32');
        warning.returns(new Promise(() => {}));
        monitor = startWindowsProxyEnvironmentNotification(read);
        assert.ok(monitor);
        await monitor.check();
        await monitor.check();
        assert.strictEqual(read.callCount, 2);
        monitor.dispose();
    });

    test('notificationLevel off suppresses the notification', async () => {
        sandbox.stub(process, 'platform').value('win32');
        const original = vscode.workspace.getConfiguration;
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section, scope) => {
            const config = original(section, scope);
            return section === 'otakProxy' ? { ...config, get: () => 'off' } as unknown as vscode.WorkspaceConfiguration : config;
        });
        monitor = startWindowsProxyEnvironmentNotification(read);
        await monitor?.check();
        assert.strictEqual(warning.callCount, 0);
    });

    test('does not launch a reader on remote or non-Windows hosts', () => {
        sandbox.stub(process, 'platform').value('win32');
        sandbox.stub(vscode.env, 'remoteName').value('ssh-remote');
        assert.strictEqual(startWindowsProxyEnvironmentNotification(read), undefined);
        sandbox.stub(process, 'platform').value('linux');
        sandbox.stub(vscode.env, 'remoteName').value(undefined);
        assert.strictEqual(startWindowsProxyEnvironmentNotification(read), undefined);
        assert.strictEqual(read.callCount, 0);
    });

    test('real Windows PowerShell read obeys the JSON protocol without modifying OS settings', async function () {
        if (process.platform !== 'win32') { this.skip(); }
        const result = await readWindowsProxyEnvironment(new AbortController().signal);
        // Do not include OS values in assertion failure output.
        assert.strictEqual(typeof result.user, 'object');
        assert.strictEqual(typeof result.machine, 'object');
    });
});
