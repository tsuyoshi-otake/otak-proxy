/**
 * Property-based tests for NpmConfigManager
 * These tests verify correctness properties across many random inputs
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { validProxyUrlWithoutCredentialsGenerator } from './generators';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPropertyTestTimeout } from './helpers';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Read proxy values directly from the isolated userconfig file.
 * This avoids extra `npm config list` calls and makes the test faster and less flaky.
 */
function readProxyValuesFromNpmrc(npmrcPath: string): { proxy: string | null; httpsProxy: string | null } {
    const content = fs.readFileSync(npmrcPath, { encoding: 'utf8' });
    const lines = content.split(/\r?\n/);
    let proxy: string | null = null;
    let httpsProxy: string | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }

        const idx = line.indexOf('=');
        if (idx < 0) {
            continue;
        }

        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();

        if (key === 'proxy') {
            proxy = value;
        } else if (key === 'https-proxy') {
            httpsProxy = value;
        }
    }

    return { proxy, httpsProxy };
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
    let testDir: string | undefined;
    let userConfigPath: string | undefined;
    const numRuns = process.env.CI ? 5 : 3;

    suiteSetup(async () => {
        // Isolate npm config to avoid mutating developer machine settings and to make tests deterministic.
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-npm-prop-test-'));
        userConfigPath = path.join(testDir, '.npmrc');
        fs.writeFileSync(userConfigPath, '', { encoding: 'utf8' });

        npmAvailable = await isNpmAvailable();
    });

    suiteTeardown(() => {
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
        testDir = undefined;
        userConfigPath = undefined;
    });

    /**
     * Feature: npm-proxy-support, Property 1: npm proxy設定の適用
     * 任意の有効なproxy URLに対して、setProxy()を呼び出した後、
     * npm configのproxyとhttps-proxyの両方が同じURLに設定されているべき
     * Note: npm 11.x uses 'proxy' instead of 'http-proxy'
     * Validates: Requirements 1.1
     */
    test('Property 1: npm proxy configuration applies to both http and https', async function() {
        this.timeout(getPropertyTestTimeout(60000));
        if (!npmAvailable) {
            this.skip();
            return;
        }
        if (!userConfigPath) {
            throw new Error('Test setup error: userConfigPath not initialized');
        }
        const configPath = userConfigPath;

        await fc.assert(
            fc.asyncProperty(validProxyUrlWithoutCredentialsGenerator(), async (proxyUrl) => {
                const manager = new NpmConfigManager(configPath);

                // Set the proxy
                const result = await manager.setProxy(proxyUrl);

                // If npm is not available, skip this iteration
                if (!result.success && result.errorType === 'NOT_INSTALLED') {
                    return true;
                }

                // Verify the operation succeeded
                assert.strictEqual(result.success, true, `Failed to set proxy: ${result.error}`);

                const values = readProxyValuesFromNpmrc(configPath);

                // Both should be set to the same URL
                assert.strictEqual(values.proxy, proxyUrl, 'proxy should match the set URL');
                assert.strictEqual(values.httpsProxy, proxyUrl, 'https-proxy should match the set URL');

                // Clean up
                await manager.unsetProxy();

                return true;
            }),
            { numRuns }
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
        this.timeout(getPropertyTestTimeout(60000));
        if (!npmAvailable) {
            this.skip();
            return;
        }
        if (!userConfigPath) {
            throw new Error('Test setup error: userConfigPath not initialized');
        }
        const configPath = userConfigPath;

        await fc.assert(
            fc.asyncProperty(validProxyUrlWithoutCredentialsGenerator(), async (proxyUrl) => {
                const manager = new NpmConfigManager(configPath);
                
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
            { numRuns }
        );
    });
});
