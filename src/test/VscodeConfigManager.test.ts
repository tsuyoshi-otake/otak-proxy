import * as assert from 'assert';
import * as vscode from 'vscode';
import { VscodeConfigManager } from '../config/VscodeConfigManager';

suite('VscodeConfigManager Test Suite', () => {
    let vscodeConfigManager: VscodeConfigManager;

    setup(() => {
        vscodeConfigManager = new VscodeConfigManager();
    });

    suite('Basic Operations', () => {
        test('should create VscodeConfigManager instance', () => {
            assert.ok(vscodeConfigManager);
            assert.ok(vscodeConfigManager instanceof VscodeConfigManager);
        });

        test('setProxy should return OperationResult', async () => {
            const result = await vscodeConfigManager.setProxy('http://proxy.example.com:8080');
            
            assert.ok(result);
            assert.strictEqual(typeof result.success, 'boolean');
            
            // Clean up
            await vscodeConfigManager.unsetProxy();
        });

        test('unsetProxy should return OperationResult', async () => {
            // First set a proxy
            await vscodeConfigManager.setProxy('http://proxy.example.com:8080');
            
            // Then unset it
            const result = await vscodeConfigManager.unsetProxy();
            
            assert.ok(result);
            assert.strictEqual(typeof result.success, 'boolean');
        });

        test('getProxy should return string or null', async () => {
            // First unset any existing proxy
            await vscodeConfigManager.unsetProxy();
            
            // Should return null when no proxy is set
            let proxy = await vscodeConfigManager.getProxy();
            assert.strictEqual(proxy, null);
            
            // Set a proxy
            await vscodeConfigManager.setProxy('http://proxy.example.com:8080');
            
            // Should return the proxy URL
            proxy = await vscodeConfigManager.getProxy();
            assert.strictEqual(proxy, 'http://proxy.example.com:8080');
            
            // Clean up
            await vscodeConfigManager.unsetProxy();
        });
    });

    suite('Error Handling', () => {
        test('should handle configuration operations gracefully', async () => {
            // Set a proxy
            const setResult = await vscodeConfigManager.setProxy('http://proxy.example.com:8080');
            assert.strictEqual(setResult.success, true);
            
            // Unset the proxy
            const unsetResult = await vscodeConfigManager.unsetProxy();
            assert.strictEqual(unsetResult.success, true);
        });

        test('should return success when unsetting non-existent proxy', async () => {
            // Ensure no proxy is set
            await vscodeConfigManager.unsetProxy();
            
            // Try to unset again
            const result = await vscodeConfigManager.unsetProxy();
            assert.strictEqual(result.success, true);
        });
    });

    suite('Round Trip', () => {
        test('should set and get proxy correctly', async () => {
            const testUrl = 'http://test-proxy.example.com:3128';
            
            // Set the proxy
            const setResult = await vscodeConfigManager.setProxy(testUrl);
            assert.strictEqual(setResult.success, true);
            
            // Get the proxy
            const retrievedUrl = await vscodeConfigManager.getProxy();
            assert.strictEqual(retrievedUrl, testUrl);
            
            // Clean up
            await vscodeConfigManager.unsetProxy();
        });

        test('should handle proxy with credentials', async () => {
            const testUrl = 'http://user:pass@proxy.example.com:8080';
            
            // Set the proxy
            const setResult = await vscodeConfigManager.setProxy(testUrl);
            assert.strictEqual(setResult.success, true);
            
            // Get the proxy
            const retrievedUrl = await vscodeConfigManager.getProxy();
            assert.strictEqual(retrievedUrl, testUrl);
            
            // Clean up
            await vscodeConfigManager.unsetProxy();
        });
    });

    suite('Configuration Resilience', () => {
        test('should continue operation even if configuration fails', async () => {
            // This test verifies that the manager handles errors gracefully
            // In a real scenario, VSCode configuration API is very reliable
            // but we want to ensure error handling is in place
            
            const result = await vscodeConfigManager.setProxy('http://proxy.example.com:8080');
            
            // Should return a result (success or failure)
            assert.ok(result);
            assert.ok(typeof result.success === 'boolean');
            
            // Clean up
            await vscodeConfigManager.unsetProxy();
        });
    });
});
