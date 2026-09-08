import * as assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    GIT_CONFIG_COMMAND_TIMEOUT_MS,
    GIT_LEGACY_NON_ROUTING_PROXY_KEY,
    GIT_ROUTING_PROXY_KEY,
    GitConfigManager
} from '../config/GitConfigManager';
import { createFakeGitConfig } from './fakeConfigStores';

const execFileAsync = promisify(execFile);

suite('GitConfigManager Test Suite', () => {
    let gitConfigManager: GitConfigManager;

    setup(() => {
        gitConfigManager = new GitConfigManager();
    });

    suite('Basic Operations', () => {
    test('should create GitConfigManager instance', () => {
        assert.ok(gitConfigManager);
    });

    test('uses the shared high-load command timeout', () => {
        assert.strictEqual(GIT_CONFIG_COMMAND_TIMEOUT_MS, 15000);
    });

        test('setProxy should return OperationResult', async () => {
            const result = await gitConfigManager.setProxy('http://proxy.example.com:8080');
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
            
            // Clean up if successful
            if (result.success) {
                await gitConfigManager.unsetProxy();
            }
        });

        test('unsetProxy should return OperationResult', async () => {
            const result = await gitConfigManager.unsetProxy();
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
        });

        test('getProxy should return string or null', async () => {
            const result = await gitConfigManager.getProxy();
            assert.ok(result === null || typeof result === 'string');
        });

        test('passes encoded credential URLs to git as a single argv without a shell', async () => {
            const calls: Array<{ command: string; args: string[] }> = [];
            const git = createFakeGitConfig();
            const manager = new GitConfigManager({
                commandRunner: async (command, args, options) => {
                    calls.push({ command, args });
                    return git.runner(command, args, options);
                }
            });
            const url = 'http://user:abc%21def@proxy.example:8080';
            const result = await manager.setProxy(url);
            assert.strictEqual(result.success, true, result.error);
            assert.ok(calls.length >= 1);
            for (const call of calls) {
                assert.strictEqual(call.command, 'git');
                assert.ok(!call.args.includes('/c'));
                if (call.args.includes('--replace-all')) {
                    assert.ok(call.args.includes(url));
                }
            }
        });

        test('setProxy writes only the http.proxy routing key', async () => {
            const calls: Array<{ command: string; args: string[] }> = [];
            const git = createFakeGitConfig();
            const manager = new GitConfigManager({
                commandRunner: async (command, args, options) => {
                    calls.push({ command, args });
                    return git.runner(command, args, options);
                }
            });

            const result = await manager.setProxy('http://proxy.example.com:8080');
            assert.strictEqual(result.success, true, result.error);
            const writes = calls.filter(call => call.args.includes('--replace-all'));
            assert.deepStrictEqual(writes.map(call => call.args), [
                ['config', '--global', '--replace-all', GIT_ROUTING_PROXY_KEY, 'http://proxy.example.com:8080']
            ]);
            assert.ok(!writes.some(call => call.args.includes(GIT_LEGACY_NON_ROUTING_PROXY_KEY)));
            assert.strictEqual(git.get(GIT_ROUTING_PROXY_KEY), 'http://proxy.example.com:8080');
            assert.strictEqual(git.get(GIT_LEGACY_NON_ROUTING_PROXY_KEY), null);
        });

        test('getProxy ignores leftover https.proxy and does not treat it as routing', async () => {
            const leftover = 'http://leftover-https.example.com:8080';
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    if (args.includes('--get-regexp')) {
                        return { stdout: `${GIT_LEGACY_NON_ROUTING_PROXY_KEY} ${leftover}\n`, stderr: '' };
                    }
                    return { stdout: '', stderr: '' };
                }
            });

            assert.strictEqual(await manager.getProxy(), null);
            const inspection = await manager.inspectProxy();
            assert.strictEqual(inspection.status, 'available');
            assert.deepStrictEqual(inspection.values, {
                'http.proxy': null,
                'https.proxy': leftover
            });
        });

        test('unsetProxy still clears leftover https.proxy', async () => {
            const calls: Array<string[]> = [];
            const leftover = 'http://leftover-https.example.com:8080';
            let leftoverPresent = true;
            const manager = new GitConfigManager({
                commandRunner: async (_command, args) => {
                    calls.push(args);
                    if (args.includes('--unset-all') && args.includes(GIT_LEGACY_NON_ROUTING_PROXY_KEY)) {
                        leftoverPresent = false;
                        return { stdout: '', stderr: '' };
                    }
                    if (args.includes('--get-regexp')) {
                        return leftoverPresent
                            ? { stdout: `${GIT_LEGACY_NON_ROUTING_PROXY_KEY} ${leftover}\n`, stderr: '' }
                            : { stdout: '', stderr: '' };
                    }
                    if (args.includes('--get-all') && args.includes(GIT_LEGACY_NON_ROUTING_PROXY_KEY)) {
                        if (!leftoverPresent) {
                            throw Object.assign(new Error('missing'), { code: 1 });
                        }
                        return { stdout: `${leftover}\n`, stderr: '' };
                    }
                    if (args.includes('--get-all')) {
                        throw Object.assign(new Error('missing'), { code: 1 });
                    }
                    return { stdout: '', stderr: '' };
                }
            });

            const result = await manager.unsetProxy();
            assert.strictEqual(result.success, true, result.error);
            assert.ok(calls.some(args =>
                args.includes('--unset-all') && args.includes(GIT_LEGACY_NON_ROUTING_PROXY_KEY)
            ));
        });
    });

    suite('Error Handling', () => {
        test('should handle errors gracefully', async () => {
            // This test verifies that errors are caught and returned as OperationResult
            // rather than throwing exceptions
            const result = await gitConfigManager.setProxy('http://proxy.example.com:8080');
            
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
                await gitConfigManager.unsetProxy();
            }
        });
    });

    suite('Round Trip', () => {
        test('should set and get proxy correctly', async function() {
            // Skip this test if Git is not installed
            const testUrl = 'http://test-proxy.example.com:8080';
            
            // Try to set proxy
            const setResult = await gitConfigManager.setProxy(testUrl);
            
            if (!setResult.success) {
                // If Git is not installed or not accessible, skip this test
                if (setResult.errorType === 'NOT_INSTALLED') {
                    this.skip();
                    return;
                }
            }
            
            assert.strictEqual(setResult.success, true, `Failed to set proxy: ${setResult.error}`);
            
            // Get the proxy
            const getResult = await gitConfigManager.getProxy();
            assert.strictEqual(getResult, testUrl);
            
            // Clean up
            const unsetResult = await gitConfigManager.unsetProxy();
            assert.strictEqual(unsetResult.success, true);
            
            // Verify it's unset
            const finalResult = await gitConfigManager.getProxy();
            assert.strictEqual(finalResult, null);
        });

        test('should inspect and selectively clear individual proxy keys', async function() {
            const testUrl = 'http://owned-proxy.example.com:8080';
            const setResult = await gitConfigManager.setProxy(testUrl);
            if (!setResult.success && setResult.errorType === 'NOT_INSTALLED') {
                this.skip();
                return;
            }
            assert.strictEqual(setResult.success, true, `Failed to set proxy: ${setResult.error}`);

            const before = await gitConfigManager.inspectProxy();
            assert.strictEqual(before.status, 'available');
            assert.deepStrictEqual(before.values, {
                'http.proxy': testUrl,
                'https.proxy': null
            });

            try {
                await execFileAsync('git', ['config', '--global', GIT_LEGACY_NON_ROUTING_PROXY_KEY, testUrl], {
                    timeout: 15000,
                    encoding: 'utf8',
                    windowsHide: true
                });
            } catch (error) {
                this.skip();
                return;
            }

            const withLeftover = await gitConfigManager.inspectProxy();
            assert.strictEqual(withLeftover.status, 'available');
            assert.deepStrictEqual(withLeftover.values, {
                'http.proxy': testUrl,
                'https.proxy': testUrl
            });
            assert.strictEqual(await gitConfigManager.getProxy(), testUrl);

            const unsetResult = await gitConfigManager.unsetProxyKeys([GIT_ROUTING_PROXY_KEY]);
            assert.strictEqual(unsetResult.success, true);

            const after = await gitConfigManager.inspectProxy();
            assert.strictEqual(after.status, 'available');
            assert.deepStrictEqual(after.values, {
                'http.proxy': null,
                'https.proxy': testUrl
            });
            assert.strictEqual(await gitConfigManager.getProxy(), null, 'leftover https.proxy is not a routing plane');

            await gitConfigManager.unsetProxyKeys([GIT_LEGACY_NON_ROUTING_PROXY_KEY]);
        });
    });
});
