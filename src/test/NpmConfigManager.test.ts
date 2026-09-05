import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    classifyNpmConfigError,
    NPM_CONFIG_COMMAND_TIMEOUT_MS,
    NpmConfigManager
} from '../config/NpmConfigManager';
import { PlatformMocker } from './crossPlatformMockers';

suite('NpmConfigManager Test Suite', () => {
    let npmConfigManager: NpmConfigManager;
    let testDir: string | undefined;
    let userConfigPath: string | undefined;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-npm-test-'));
        userConfigPath = path.join(testDir, '.npmrc');
        fs.writeFileSync(userConfigPath, '', { encoding: 'utf8' });
        npmConfigManager = new NpmConfigManager(userConfigPath);
    });

    teardown(() => {
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        testDir = undefined;
        userConfigPath = undefined;
    });

    suite('Basic Operations', () => {
        test('should create NpmConfigManager instance', () => {
            assert.ok(npmConfigManager);
        });

        test('setProxy should return OperationResult', async function() {
            this.timeout(45000);
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });

        test('unsetProxy should return OperationResult', async function() {
            this.timeout(45000);
            const result = await npmConfigManager.unsetProxy();
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
        });

        test('getProxy should return string or null', async function() {
            this.timeout(45000);
            const result = await npmConfigManager.getProxy();
            assert.ok(result === null || typeof result === 'string');
        });
    });

    suite('Error Handling', () => {
        test('should handle errors gracefully', async function() {
            this.timeout(45000);
            // This test verifies that errors are caught and returned as OperationResult
            // rather than throwing exceptions
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            
            // Result should always be an object with success property
            assert.ok(result);
            assert.ok('success' in result);
            
            if (!result.success) {
                // If it failed, it should have error details
                assert.ok(result.error);
                assert.ok(result.errorType);
            }
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });

        test('should handle npm not installed error', async function() {
            this.timeout(20000);
            // This test documents the expected behavior when npm is not installed
            // In real scenarios, this would be tested with mocking
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            
            if (!result.success && result.errorType === 'NOT_INSTALLED') {
                assert.strictEqual(result.error, 'npm is not installed or not in PATH');
            }
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });

        (['win32', 'linux', 'darwin'] as NodeJS.Platform[]).forEach(platform => {
            test(`should return NOT_INSTALLED when npm cannot be resolved from PATH on ${platform}`, async function() {
                this.timeout(20000);
                const originalPath = process.env.PATH;
                const originalPathWindows = process.env.Path;
                const restorePlatform = PlatformMocker.mockPlatform(platform);

                try {
                    process.env.PATH = '';
                    process.env.Path = '';

                    const manager = new NpmConfigManager(userConfigPath);
                    const result = await manager.setProxy('http://proxy.example.com:8080');

                    assert.strictEqual(result.success, false);
                    assert.strictEqual(result.errorType, 'NOT_INSTALLED');
                    assert.strictEqual(result.error, 'npm is not installed or not in PATH');
                } finally {
                    restorePlatform();
                    if (originalPath === undefined) {
                        delete process.env.PATH;
                    } else {
                        process.env.PATH = originalPath;
                    }

                    if (originalPathWindows === undefined) {
                        delete process.env.Path;
                    } else {
                        process.env.Path = originalPathWindows;
                    }
                }
            });
        });

        test('should handle permission errors', async function() {
            this.timeout(45000);
            // This test documents the expected behavior for permission errors
            // In real scenarios, this would be tested with mocking
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            
            if (!result.success && result.errorType === 'NO_PERMISSION') {
                assert.strictEqual(result.error, 'Permission denied when accessing npm configuration');
            }
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });

        test('should handle timeout errors', async function() {
            this.timeout(45000);
            // This test documents the expected behavior for timeout errors
            // In real scenarios, this would be tested with mocking
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');

            if (!result.success && result.errorType === 'TIMEOUT') {
                assert.strictEqual(result.error, `npm command timed out after ${NPM_CONFIG_COMMAND_TIMEOUT_MS}ms`);
            }
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });
    });

    suite('Error Classification', () => {
        test('uses the load-tolerant npm command timeout in timeout errors', () => {
            const result = classifyNpmConfigError({
                message: 'Command timed out',
                killed: true,
                signal: 'SIGTERM'
            }, NPM_CONFIG_COMMAND_TIMEOUT_MS);

            assert.strictEqual(NPM_CONFIG_COMMAND_TIMEOUT_MS, 15000);
            assert.strictEqual(result.errorType, 'TIMEOUT');
            assert.strictEqual(result.error, 'npm command timed out after 15000ms');
        });

        test('should classify Windows cmd missing npm output as NOT_INSTALLED', () => {
            const result = classifyNpmConfigError({
                message: 'Command failed: C:\\Windows\\System32\\cmd.exe /d /s /c npm config set proxy http://proxy.example.com:8080',
                stderr: '\'npm\' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n',
                code: 1
            }, 5000);

            assert.strictEqual(result.errorType, 'NOT_INSTALLED');
            assert.strictEqual(result.error, 'npm is not installed or not in PATH');
        });

    });

    suite('Windows spawn safety (#52)', () => {
        function isCmdExecutable(command: string): boolean {
            const base = path.basename(command).toLowerCase();
            return base === 'cmd.exe' || base === 'cmd';
        }

        test('does not invoke cmd.exe when setting a reserved-character credential URL', async () => {
            const calls: Array<{ command: string; args: string[] }> = [];
            const url = 'http://user:x%25OS%25y@proxy.example:8080';
            const manager = new NpmConfigManager(userConfigPath, {
                isWindows: true,
                env: process.env,
                commandAvailable: () => true,
                commandRunner: async (command, args) => {
                    calls.push({ command, args });
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.setProxy(url);
            assert.strictEqual(result.success, true, result.error);
            assert.ok(calls.length >= 1);
            const setCalls = calls.filter(call => call.args.includes('set'));
            assert.ok(setCalls.length >= 1);
            for (const call of calls) {
                assert.strictEqual(isCmdExecutable(call.command), false, 'Windows npm must not start cmd.exe');
                assert.ok(!call.args.includes('/c'), 'Windows npm must not use cmd /c');
                assert.ok(!call.args.includes('/s'), 'Windows npm must not use cmd /s');
            }
            for (const call of setCalls) {
                assert.ok(call.args.includes(url), 'proxy URL must remain a single argv element');
            }
        });

        test('Windows npm path does not expand %OS% or split on &', async function() {
            if (process.platform !== 'win32') {
                this.skip();
                return;
            }
            this.timeout(45000);
            if (!testDir || !userConfigPath) {
                assert.fail('test directory was not created');
            }
            if (testDir.includes(' ')) {
                this.skip();
                return;
            }

            const osUrl = 'http://user:x%OS%y@proxy.example:8080';
            const marker = path.join(testDir, 'split.marker');
            const ampUrl = `http://user:x&echo.>${marker}`;

            const osResult = await npmConfigManager.setProxy(osUrl);
            const npmrcAfterOs = fs.readFileSync(userConfigPath, { encoding: 'utf8' });
            assert.ok(
                !npmrcAfterOs.includes('Windows_NT'),
                'cmd %OS% expansion must not rewrite the npmrc value'
            );
            if (osResult.success) {
                assert.ok(
                    npmrcAfterOs.includes('%OS%'),
                    'literal %OS% must be preserved when npm accepts the URL'
                );
            }

            await npmConfigManager.setProxy(ampUrl);
            assert.strictEqual(
                fs.existsSync(marker),
                false,
                'unquoted & must not launch a second command that writes a marker'
            );
        });
    });

    suite('Round Trip', () => {
        test('should set and get proxy correctly', async function() {
            // Worst case: 8 npm commands * 15s each + overhead
            this.timeout(135000);
            // Skip this test if npm is not installed
            const testUrl = 'http://test-proxy.example.com:8080';
            
            // Try to set proxy
            const setResult = await npmConfigManager.setProxy(testUrl);
            
            if (!setResult.success) {
                // If npm is not installed or not accessible, skip this test
                if (setResult.errorType === 'NOT_INSTALLED') {
                    this.skip();
                    return;
                }
            }
            
            assert.strictEqual(setResult.success, true, `Failed to set proxy: ${setResult.error}`);
            
            // Get the proxy
            const getResult = await npmConfigManager.getProxy();
            assert.strictEqual(getResult, testUrl);
            
            // Clean up
            const unsetResult = await npmConfigManager.unsetProxy();
            assert.strictEqual(unsetResult.success, true);
            
            // Verify it's unset
            const finalResult = await npmConfigManager.getProxy();
            assert.strictEqual(finalResult, null);
        });

        test('should inspect and selectively clear individual proxy keys', async function() {
            // Worst case: 8 npm commands * 15s each + overhead
            this.timeout(135000);
            const testUrl = 'http://owned-proxy.example.com:8080';
            const setResult = await npmConfigManager.setProxy(testUrl);
            if (!setResult.success && setResult.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(setResult.success, true, `Failed to set proxy: ${setResult.error}`);

            const before = await npmConfigManager.inspectProxy();
            assert.strictEqual(before.status, 'available');
            assert.deepStrictEqual(before.values, {
                proxy: testUrl,
                'https-proxy': testUrl
            });

            const unsetResult = await npmConfigManager.unsetProxyKeys(['proxy']);
            assert.strictEqual(unsetResult.success, true);

            const after = await npmConfigManager.inspectProxy();
            assert.strictEqual(after.status, 'available');
            assert.deepStrictEqual(after.values, {
                proxy: null,
                'https-proxy': testUrl
            });

            await npmConfigManager.unsetProxyKeys(['https-proxy']);
        });

        test('preserves an external value that replaced the owned value before delete', async function() {
            this.timeout(135000);
            const owned = 'http://owned-proxy.example.com:8080';
            const external = 'http://external-proxy.example.com:8080';
            const setResult = await npmConfigManager.setProxy(owned);
            if (!setResult.success && setResult.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(setResult.success, true, setResult.error);

            const overwrite = await npmConfigManager.setProxy(external);
            assert.strictEqual(overwrite.success, true, overwrite.error);

            const unsetResult = await npmConfigManager.unsetProxyKeys(
                ['proxy', 'https-proxy'],
                { proxy: owned, 'https-proxy': owned }
            );
            assert.strictEqual(unsetResult.success, true, unsetResult.error);

            const after = await npmConfigManager.inspectProxy();
            assert.strictEqual(after.status, 'available');
            assert.deepStrictEqual(after.values, {
                proxy: external,
                'https-proxy': external
            });
        });
    });
});
