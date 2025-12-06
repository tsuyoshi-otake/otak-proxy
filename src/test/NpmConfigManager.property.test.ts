/**
 * Property-based tests for NpmConfigManager
 * These tests verify correctness properties across many random inputs
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { validProxyUrlWithoutCredentialsGenerator } from './generators';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Helper function to get npm config value
 * Note: npm 11.x protects certain config values, so we use 'npm config list --json'
 */
async function getNpmConfigValue(key: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('npm', ['config', 'list', '--json'], {
            timeout: 5000,
            encoding: 'utf8',
            shell: isWindows
        });
        const config = JSON.parse(stdout);
        const value = config[key];
        return (value === undefined || value === '' || value === 'undefined' || value === 'null') ? null : value;
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
            encoding: 'utf8',
            shell: isWindows
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
     * npm configのproxyとhttps-proxyの両方が同じURLに設定されているべき
     * Note: npm 11.x uses 'proxy' instead of 'http-proxy'
     * Validates: Requirements 1.1
     */
    test('Property 1: npm proxy configuration applies to both http and https', async function() {
        this.timeout(60000);
        if (!npmAvailable) {
            this.skip();
            return;
        }

        await fc.assert(
            fc.asyncProperty(validProxyUrlWithoutCredentialsGenerator(), async (proxyUrl) => {
                const manager = new NpmConfigManager();

                // Set the proxy
                const result = await manager.setProxy(proxyUrl);

                // If npm is not available, skip this iteration
                if (!result.success && result.errorType === 'NOT_INSTALLED') {
                    return true;
                }

                // Verify the operation succeeded
                assert.strictEqual(result.success, true, `Failed to set proxy: ${result.error}`);

                // Get both config values (npm 11.x uses 'proxy' not 'http-proxy')
                const httpProxy = await getNpmConfigValue('proxy');
                const httpsProxy = await getNpmConfigValue('https-proxy');

                // Both should be set to the same URL
                assert.strictEqual(httpProxy, proxyUrl, 'proxy should match the set URL');
                assert.strictEqual(httpsProxy, proxyUrl, 'https-proxy should match the set URL');

                // Clean up
                await manager.unsetProxy();

                return true;
            }),
            { numRuns: 5 }
        );
    });

    /**
     * Feature: npm-proxy-support, Property 7: 設定取得のラウンドトリップ
     * 任意の有効なproxy URLに対して、setProxy()してからgetProxy()を呼び出すと、
     * 同じURLが返されるべき
     * Note: npm 11.x masks credentials, so we test with URLs without credentials
     * Validates: Requirements 3.1
     */
    test('Property 7: Round trip consistency for npm proxy configuration', async function() {
        this.timeout(60000);
        if (!npmAvailable) {
            this.skip();
            return;
        }

        await fc.assert(
            fc.asyncProperty(validProxyUrlWithoutCredentialsGenerator(), async (proxyUrl) => {
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
            { numRuns: 5 }
        );
    });
});
