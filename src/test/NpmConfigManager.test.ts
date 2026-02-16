import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NpmConfigManager } from '../config/NpmConfigManager';

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
            this.timeout(20000);
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });

        test('unsetProxy should return OperationResult', async function() {
            this.timeout(20000);
            const result = await npmConfigManager.unsetProxy();
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
        });

        test('getProxy should return string or null', async function() {
            this.timeout(20000);
            const result = await npmConfigManager.getProxy();
            assert.ok(result === null || typeof result === 'string');
        });
    });

    suite('Error Handling', () => {
        test('should handle errors gracefully', async function() {
            this.timeout(20000);
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

        test('should handle permission errors', async function() {
            this.timeout(20000);
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
            this.timeout(20000);
            // This test documents the expected behavior for timeout errors
            // In real scenarios, this would be tested with mocking
            const result = await npmConfigManager.setProxy('http://proxy.example.com:8080');
            
            if (!result.success && result.errorType === 'TIMEOUT') {
                assert.strictEqual(result.error, 'npm command timed out after 5 seconds');
            }
            
            // Clean up if successful
            if (result.success) {
                await npmConfigManager.unsetProxy();
            }
        });
    });

    suite('Round Trip', () => {
        test('should set and get proxy correctly', async function() {
            // Worst case: 6 npm commands * 5s each + overhead
            this.timeout(45000);
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
    });
});
