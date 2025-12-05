import * as assert from 'assert';
import { GitConfigManager } from '../config/GitConfigManager';

suite('GitConfigManager Test Suite', () => {
    let gitConfigManager: GitConfigManager;

    setup(() => {
        gitConfigManager = new GitConfigManager();
    });

    suite('Basic Operations', () => {
        test('should create GitConfigManager instance', () => {
            assert.ok(gitConfigManager);
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
    });
});
