/**
 * Property-based tests for SharedStateFile
 * Feature: multi-instance-sync
 * Requirements: 5.2 - Ensures serialization/deserialization preserves state
 *
 * Uses fast-check for property-based testing
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SharedStateFile, SharedState } from '../../sync/SharedStateFile';
import { ProxyMode, ProxyState } from '../../core/types';

suite('SharedStateFile Property-Based Tests', () => {
    let testDir: string;
    let sharedStateFile: SharedStateFile;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-ssf-prop-test-'));
        sharedStateFile = new SharedStateFile(testDir);
    });

    teardown(() => {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Arbitrary generators for property-based testing
     */
    const proxyModeArb = fc.constantFrom(ProxyMode.Off, ProxyMode.Manual, ProxyMode.Auto);

    const proxyStateArb: fc.Arbitrary<ProxyState> = fc.record({
        mode: proxyModeArb,
        manualProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
        autoProxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
        gitConfigured: fc.option(fc.boolean(), { nil: undefined }),
        vscodeConfigured: fc.option(fc.boolean(), { nil: undefined }),
        npmConfigured: fc.option(fc.boolean(), { nil: undefined }),
        systemProxyDetected: fc.option(fc.boolean(), { nil: undefined }),
        proxyReachable: fc.option(fc.boolean(), { nil: undefined }),
        lastTestTimestamp: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
        usingFallbackProxy: fc.option(fc.boolean(), { nil: undefined }),
        autoModeOff: fc.option(fc.boolean(), { nil: undefined })
    });

    const testResultArb = fc.record({
        success: fc.boolean(),
        testUrls: fc.array(fc.webUrl(), { minLength: 1, maxLength: 5 }),
        errors: fc.array(
            fc.record({
                url: fc.webUrl(),
                message: fc.string({ minLength: 1, maxLength: 100 })
            }),
            { maxLength: 5 }
        ),
        proxyUrl: fc.option(fc.webUrl(), { nil: undefined }),
        timestamp: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
        duration: fc.option(fc.integer({ min: 0, max: 60000 }), { nil: undefined })
    });

    const sharedStateArb: fc.Arbitrary<SharedState> = fc.record({
        version: fc.integer({ min: 1, max: 100 }),
        lastModified: fc.integer({ min: 0, max: Date.now() + 1000000 }),
        lastModifiedBy: fc.uuid(),
        proxyState: proxyStateArb,
        testResult: fc.option(testResultArb, { nil: undefined })
    });

    /**
     * Property: Write then read preserves all state
     */
    test('write then read preserves state', async () => {
        await fc.assert(
            fc.asyncProperty(sharedStateArb, async (state) => {
                // Create fresh instance for each test to avoid file conflicts
                const localTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ssf-'));
                const localStateFile = new SharedStateFile(localTestDir);

                try {
                    await localStateFile.write(state);
                    const readState = await localStateFile.read();

                    assert.ok(readState, 'Read state should not be null');
                    assert.strictEqual(readState!.version, state.version);
                    assert.strictEqual(readState!.lastModified, state.lastModified);
                    assert.strictEqual(readState!.lastModifiedBy, state.lastModifiedBy);
                    assert.strictEqual(readState!.proxyState.mode, state.proxyState.mode);
                } finally {
                    fs.rmSync(localTestDir, { recursive: true, force: true });
                }
            }),
            { numRuns: 20 } // Fewer runs for async file operations
        );
    });

    /**
     * Property: Multiple writes don't corrupt the file
     */
    test('multiple sequential writes maintain file integrity', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(sharedStateArb, { minLength: 2, maxLength: 5 }),
                async (states) => {
                    const localTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ssf-multi-'));
                    const localStateFile = new SharedStateFile(localTestDir);

                    try {
                        // Write all states sequentially
                        for (const state of states) {
                            await localStateFile.write(state);
                        }

                        // Read should return the last written state
                        const lastState = states[states.length - 1];
                        const readState = await localStateFile.read();

                        assert.ok(readState, 'Read state should not be null');
                        assert.strictEqual(readState!.version, lastState.version);
                        assert.strictEqual(readState!.lastModifiedBy, lastState.lastModifiedBy);
                    } finally {
                        fs.rmSync(localTestDir, { recursive: true, force: true });
                    }
                }
            ),
            { numRuns: 10 }
        );
    });

    /**
     * Property: ProxyState mode is always preserved
     */
    test('proxy mode is always preserved through serialization', async () => {
        await fc.assert(
            fc.asyncProperty(proxyModeArb, async (mode) => {
                const localTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ssf-mode-'));
                const localStateFile = new SharedStateFile(localTestDir);

                try {
                    const state: SharedState = {
                        version: 1,
                        lastModified: Date.now(),
                        lastModifiedBy: 'test',
                        proxyState: { mode }
                    };

                    await localStateFile.write(state);
                    const readState = await localStateFile.read();

                    assert.ok(readState);
                    assert.strictEqual(readState!.proxyState.mode, mode);
                } finally {
                    fs.rmSync(localTestDir, { recursive: true, force: true });
                }
            }),
            { numRuns: 30 }
        );
    });

    /**
     * Property: URLs with special characters are preserved
     */
    test('proxy URLs with special characters are preserved', async () => {
        const urlArb = fc.webUrl().filter(url => url.length < 500); // Reasonable URL length

        await fc.assert(
            fc.asyncProperty(urlArb, async (url) => {
                const localTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ssf-url-'));
                const localStateFile = new SharedStateFile(localTestDir);

                try {
                    const state: SharedState = {
                        version: 1,
                        lastModified: Date.now(),
                        lastModifiedBy: 'test',
                        proxyState: {
                            mode: ProxyMode.Manual,
                            manualProxyUrl: url
                        }
                    };

                    await localStateFile.write(state);
                    const readState = await localStateFile.read();

                    assert.ok(readState);
                    assert.strictEqual(readState!.proxyState.manualProxyUrl, url);
                } finally {
                    fs.rmSync(localTestDir, { recursive: true, force: true });
                }
            }),
            { numRuns: 20 }
        );
    });

    /**
     * Property: Test results are preserved
     */
    test('test results are preserved through serialization', async () => {
        await fc.assert(
            fc.asyncProperty(testResultArb, async (testResult) => {
                const localTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-ssf-test-'));
                const localStateFile = new SharedStateFile(localTestDir);

                try {
                    const state: SharedState = {
                        version: 1,
                        lastModified: Date.now(),
                        lastModifiedBy: 'test',
                        proxyState: { mode: ProxyMode.Auto },
                        testResult
                    };

                    await localStateFile.write(state);
                    const readState = await localStateFile.read();

                    assert.ok(readState);
                    assert.ok(readState!.testResult);
                    assert.strictEqual(readState!.testResult!.success, testResult.success);
                    assert.deepStrictEqual(readState!.testResult!.testUrls, testResult.testUrls);
                    assert.strictEqual(readState!.testResult!.errors.length, testResult.errors.length);
                } finally {
                    fs.rmSync(localTestDir, { recursive: true, force: true });
                }
            }),
            { numRuns: 15 }
        );
    });
});
