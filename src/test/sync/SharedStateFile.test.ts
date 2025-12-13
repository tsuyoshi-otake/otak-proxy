/**
 * Unit tests for SharedStateFile
 * Feature: multi-instance-sync
 * Requirements: 5.1, 5.2, 5.5, 7.2
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SharedStateFile, SharedState, ISharedStateFile } from '../../sync/SharedStateFile';
import { ProxyMode } from '../../core/types';

suite('SharedStateFile Unit Tests', () => {
    let testDir: string;
    let sharedStateFile: ISharedStateFile;

    setup(() => {
        // Create a temporary directory for tests
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-test-'));
        sharedStateFile = new SharedStateFile(testDir);
    });

    teardown(() => {
        // Clean up temporary directory
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Requirement 5.1: File-based sync mechanism
     */
    suite('Directory Initialization (Requirement 5.1)', () => {
        test('should create sync directory on first write', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test-instance',
                proxyState: { mode: ProxyMode.Off }
            };

            await sharedStateFile.write(state);

            const syncDir = path.join(testDir, 'otak-proxy-sync');
            assert.ok(fs.existsSync(syncDir), 'Sync directory should exist');
        });

        test('should not fail if sync directory already exists', async () => {
            // Pre-create the directory
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });

            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test-instance',
                proxyState: { mode: ProxyMode.Off }
            };

            // Should not throw
            await sharedStateFile.write(state);
            assert.ok(true, 'Write should succeed');
        });
    });

    /**
     * Requirement 5.1: Basic read/write operations
     */
    suite('Basic Read/Write Operations (Requirement 5.1)', () => {
        test('should write and read shared state', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: 1702100000000,
                lastModifiedBy: 'instance-1',
                proxyState: {
                    mode: ProxyMode.Manual,
                    manualProxyUrl: 'http://proxy.example.com:8080'
                }
            };

            await sharedStateFile.write(state);
            const readState = await sharedStateFile.read();

            assert.ok(readState, 'Read should return state');
            assert.strictEqual(readState!.version, 1);
            assert.strictEqual(readState!.lastModified, 1702100000000);
            assert.strictEqual(readState!.lastModifiedBy, 'instance-1');
            assert.strictEqual(readState!.proxyState.mode, ProxyMode.Manual);
            assert.strictEqual(readState!.proxyState.manualProxyUrl, 'http://proxy.example.com:8080');
        });

        test('should return null when file does not exist', async () => {
            const readState = await sharedStateFile.read();
            assert.strictEqual(readState, null);
        });

        test('should check file existence correctly', async () => {
            assert.strictEqual(await sharedStateFile.exists(), false);

            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test-instance',
                proxyState: { mode: ProxyMode.Off }
            };

            await sharedStateFile.write(state);
            assert.strictEqual(await sharedStateFile.exists(), true);
        });

        test('should handle test result in shared state', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Auto },
                testResult: {
                    success: true,
                    testUrls: ['https://example.com'],
                    errors: [],
                    proxyUrl: 'http://proxy:8080',
                    timestamp: Date.now(),
                    duration: 150
                }
            };

            await sharedStateFile.write(state);
            const readState = await sharedStateFile.read();

            assert.ok(readState!.testResult);
            assert.strictEqual(readState!.testResult!.success, true);
            assert.strictEqual(readState!.testResult!.testUrls.length, 1);
        });
    });

    /**
     * Requirement 5.2: Atomic write operations
     */
    suite('Atomic Write Operations (Requirement 5.2)', () => {
        test('should write atomically using temp file pattern', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Manual }
            };

            await sharedStateFile.write(state);

            // Verify no temp file remains
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            const files = fs.readdirSync(syncDir);
            const tempFiles = files.filter(f => f.includes('.tmp'));

            assert.strictEqual(tempFiles.length, 0, 'No temp files should remain');
        });

        test('should preserve file integrity after write', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Auto, autoProxyUrl: 'http://auto:8080' }
            };

            await sharedStateFile.write(state);

            // Read raw file and verify it's valid JSON
            const filePath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content);

            assert.strictEqual(parsed.version, 1);
            assert.ok(parsed.proxyState);
        });

        test('should handle multiple rapid writes correctly', async () => {
            const writes: Promise<void>[] = [];

            for (let i = 0; i < 5; i++) {
                const state: SharedState = {
                    version: 1,
                    lastModified: Date.now() + i,
                    lastModifiedBy: `instance-${i}`,
                    proxyState: { mode: ProxyMode.Manual, manualProxyUrl: `http://proxy${i}:8080` }
                };
                writes.push(sharedStateFile.write(state));
            }

            // All writes should complete without error
            await Promise.all(writes);

            // Final state should be valid
            const finalState = await sharedStateFile.read();
            assert.ok(finalState);
            assert.strictEqual(finalState!.version, 1);
        });
    });

    /**
     * Requirement 5.5, 7.2: Error handling and recovery
     */
    suite('Error Handling and Recovery (Requirements 5.5, 7.2)', () => {
        test('should recover from corrupted JSON file', async () => {
            // Write valid state first
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Manual }
            };
            await sharedStateFile.write(state);

            // Corrupt the file
            const filePath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
            fs.writeFileSync(filePath, '{invalid json}}}}}', 'utf-8');

            // Recovery should fix the file
            const recovered = await sharedStateFile.recover();
            assert.strictEqual(recovered, true);

            // File should now be readable (or deleted)
            const exists = await sharedStateFile.exists();
            // After recovery, file should either be valid or removed
            if (exists) {
                const readState = await sharedStateFile.read();
                // If file exists, it should be readable
                assert.ok(readState === null || readState.version !== undefined);
            }
        });

        test('should return false from recover when nothing to recover', async () => {
            // No file exists
            const recovered = await sharedStateFile.recover();
            assert.strictEqual(recovered, false);
        });

        test('should handle read errors gracefully', async () => {
            // Create directory but make file unreadable (if possible)
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });

            // Write empty file (will cause JSON parse error)
            const filePath = path.join(syncDir, 'sync-state.json');
            fs.writeFileSync(filePath, '', 'utf-8');

            // Should return null on error, not throw
            const state = await sharedStateFile.read();
            assert.strictEqual(state, null);
        });

        test('should handle missing proxyState field', async () => {
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });

            // Write incomplete JSON
            const filePath = path.join(syncDir, 'sync-state.json');
            fs.writeFileSync(filePath, JSON.stringify({
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'test'
                // Missing proxyState
            }), 'utf-8');

            const state = await sharedStateFile.read();
            // Should return null for invalid state
            assert.strictEqual(state, null);
        });
    });

    /**
     * Schema version handling
     */
    suite('Schema Version Handling', () => {
        test('should include schema version in written state', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Off }
            };

            await sharedStateFile.write(state);

            const filePath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

            assert.strictEqual(content.version, 1);
        });

        test('should handle future schema versions gracefully', async () => {
            const syncDir = path.join(testDir, 'otak-proxy-sync');
            fs.mkdirSync(syncDir, { recursive: true });

            // Write state with future version
            const filePath = path.join(syncDir, 'sync-state.json');
            fs.writeFileSync(filePath, JSON.stringify({
                version: 999,
                lastModified: Date.now(),
                lastModifiedBy: 'future-instance',
                proxyState: { mode: 'off' },
                futureField: 'unknown'
            }), 'utf-8');

            // Should still be able to read basic fields
            const state = await sharedStateFile.read();
            // May return null or state depending on version handling
            assert.ok(state === null || state.version === 999);
        });
    });

    /**
     * File path configuration
     */
    suite('File Path Configuration', () => {
        test('should use correct file path structure', async () => {
            const state: SharedState = {
                version: 1,
                lastModified: Date.now(),
                lastModifiedBy: 'instance-1',
                proxyState: { mode: ProxyMode.Off }
            };

            await sharedStateFile.write(state);

            const expectedPath = path.join(testDir, 'otak-proxy-sync', 'sync-state.json');
            assert.ok(fs.existsSync(expectedPath));
        });

        test('should expose file path for external use', () => {
            const filePath = sharedStateFile.getFilePath();
            assert.ok(filePath.endsWith('sync-state.json'));
            assert.ok(filePath.includes('otak-proxy-sync'));
        });
    });
});
