/**
 * Property-based tests for NpmConfigManager
 * These tests verify correctness properties across many random inputs
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { validProxyUrlGenerator } from './generators';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Helper function to get npm config value
 */
async function getNpmConfigValue(key: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('npm', ['config', 'get', key], {
            timeout: 5000,
            encoding: 'utf8'
        });
        const value = stdout.trim();
        return (value === '' || value === 'undefined') ? null : value;
    } catch {
        return null;
    }
}

/**
 * Helper function to check if npm is available
 */
async function isNpmAvailable(): Promise<boolean> {
    try {
        await execFileAsync('npm', ['--version'], {
            timeout: 5000,
            encoding: 'utf8'
        });
        return true;
    } catch {
        return false;
    }
}

suite('NpmConfigManager Property-Based Tests', () => {
    let npmAvailable: boolean;

    suiteSetup(async () => {
        npmAvailable = await isNpmAvailable();
    });

    /**
     * Feature: npm-proxy-support, Property 1: npm proxy設定の適用
     * 任意の有効なproxy URLに対して、setProxy()を呼び出した後、
     * npm configのhttp-proxyとhttps-proxyの両方が同じURLに設定されているべき
     * Validates: Requirements 1.1
     */
    test('Property 1: npm proxy configuration applies to both http and https', async function() {
        if (!npmAvailable) {
            this.skip();
            return;
        }

        await fc.assert(
            fc.asyncProperty(validProxyUrlGenerator(), async (proxyUrl) => {
                const manager = new NpmConfigManager();
                
                // Set the proxy
                const result = await manager.setProxy(proxyUrl);
                
                // If npm is not available, skip this iteration
                if (!result.success && result.errorType === 'NOT_INSTALLED') {
                    return true;
                }
                
                // Verify the operation succeeded
                assert.strictEqual(result.success, true, `Failed to set proxy: ${result.error}`);
                
                // Get both config values
                const httpProxy = await getNpmConfigValue('http-proxy');
                const httpsProxy = await getNpmConfigValue('https-proxy');
                
                // Both should be set to the same URL
                assert.strictEqual(httpProxy, proxyUrl, 'http-proxy should match the set URL');
                assert.strictEqual(httpsProxy, proxyUrl, 'https-proxy should match the set URL');
                
                // Clean up
                await manager.unsetProxy();
                
                return true;
            }),
            { numRuns: 100 }
        );
    });

    /**
     * Feature: npm-proxy-support, Property 7: 設定取得のラウンドトリップ
     * 任意の有効なproxy URLに対して、setProxy()してからgetProxy()を呼び出すと、
     * 同じURLが返されるべき
     * Validates: Requirements 3.1
     */
    test('Property 7: Round trip consistency for npm proxy configuration', async function() {
        if (!npmAvailable) {
            this.skip();
            return;
        }

        await fc.assert(
            fc.asyncProperty(validProxyUrlGenerator(), async (proxyUrl) => {
                const manager = new NpmConfigManager();
                
                // Set the proxy
                const setResult = await manager.setProxy(proxyUrl);
                
                // If npm is not available, skip this iteration
                if (!setResult.success && setResult.errorType === 'NOT_INSTALLED') {
                    return true;
                }
                
                // Verify the operation succeeded
                assert.strictEqual(setResult.success, true, `Failed to set proxy: ${setResult.error}`);
                
                // Get the proxy back
                const getResult = await manager.getProxy();
                
                // Should return the same URL
                assert.strictEqual(getResult, proxyUrl, 'getProxy() should return the same URL that was set');
                
                // Clean up
                await manager.unsetProxy();
                
                // Verify it's unset
                const finalResult = await manager.getProxy();
                assert.strictEqual(finalResult, null, 'After unsetProxy(), getProxy() should return null');
                
                return true;
            }),
            { numRuns: 100 }
        );
    });
});
