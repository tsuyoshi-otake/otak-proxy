import * as assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { startWindowsProxyEnvironmentNotification } from '../monitoring/WindowsProxyEnvironmentNotification';
import {
    PROXY_ENVIRONMENT_NAMES, readWindowsProxyEnvironment,
    WindowsProxyEnvironmentMonitor, WindowsProxyEnvironmentSnapshot
} from '../monitoring/WindowsProxyEnvironment';

const execFileAsync = promisify(execFile);

// Test-only oracle: the read the monitor used before #108 (PowerShell and
// [Environment]::GetEnvironmentVariable), kept to compare snapshots on the
// real registry. Fixed input only.
const POWERSHELL_ORACLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = @{}
foreach ($scope in @('User', 'Machine')) {
    $values = @{}
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        $values[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]$scope)
    }
    $result[$scope.ToLowerInvariant()] = $values
}
ConvertTo-Json -InputObject $result -Compress
`;

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
        read = sandbox.stub().callsFake(async () => saved);
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
        assert.strictEqual(read.callCount, 0, 'with notifications off nothing is read');
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

    test('real reg query read has the snapshot shape and agrees with the PowerShell read it replaced (read-only)', async function () {
        if (process.platform !== 'win32') { this.skip(); }
        this.timeout(30_000);
        const { stdout } = await execFileAsync('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_ORACLE_SCRIPT
        ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
        const oracle = JSON.parse(stdout) as Record<'user' | 'machine', Record<string, string | null>>;

        const result = await readWindowsProxyEnvironment(new AbortController().signal);

        // Never put an OS value in an assertion: compare, then report names only.
        const mismatching: string[] = [];
        let unknown = 0;
        for (const scope of ['user', 'machine'] as const) {
            for (const name of PROXY_ENVIRONMENT_NAMES) {
                const value = result[scope][name];
                assert.ok(value === null || value === undefined || typeof value === 'string', `${scope}.${name} has the wrong type`);
                if (value === undefined) {
                    unknown++;
                } else if (value !== oracle[scope][name]) {
                    mismatching.push(`${scope}.${name}`);
                }
            }
        }
        assert.deepStrictEqual(mismatching, [], `${unknown} of 8 values were unknown and excluded`);
    });
});
