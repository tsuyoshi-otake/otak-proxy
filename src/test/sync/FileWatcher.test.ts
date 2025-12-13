/**
 * Unit tests for FileWatcher
 * Feature: multi-instance-sync
 * Requirements: 5.3, 5.4
 *
 * TDD: RED phase - Write tests first
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { FileWatcher, IFileWatcher } from '../../sync/FileWatcher';

suite('FileWatcher Unit Tests', () => {
    let testDir: string;
    let testFile: string;
    let watcher: IFileWatcher;

    setup(() => {
        // Create a temporary directory and file for tests
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-watcher-test-'));
        testFile = path.join(testDir, 'test-state.json');
        fs.writeFileSync(testFile, '{"test": true}', 'utf-8');
        watcher = new FileWatcher();
    });

    teardown(async () => {
        // Stop watcher and clean up
        watcher.stop();

        // Wait a bit for watcher to fully stop
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    /**
     * Requirement 5.3: File change detection
     */
    suite('File Change Detection (Requirement 5.3)', () => {
        test('should detect file changes', (done) => {
            let changeDetected = false;

            watcher.on('change', () => {
                changeDetected = true;
                done();
            });

            watcher.start(testFile);

            // Modify the file after a short delay
            setTimeout(() => {
                fs.writeFileSync(testFile, '{"test": false}', 'utf-8');
            }, 200);

            // Timeout if change not detected
            setTimeout(() => {
                if (!changeDetected) {
                    done(new Error('File change not detected within timeout'));
                }
            }, 3000);
        });

        test('should not emit events after stop', (done) => {
            let changeCount = 0;

            watcher.on('change', () => {
                changeCount++;
            });

            watcher.start(testFile);
            watcher.stop();

            // Modify the file
            setTimeout(() => {
                fs.writeFileSync(testFile, '{"test": false}', 'utf-8');
            }, 100);

            // Check that no changes were detected
            setTimeout(() => {
                assert.strictEqual(changeCount, 0, 'Should not detect changes after stop');
                done();
            }, 500);
        });
    });

    /**
     * Requirement 5.4: Continuous monitoring
     */
    suite('Continuous Monitoring (Requirement 5.4)', () => {
        test('should report watching state correctly', () => {
            assert.strictEqual(watcher.isWatching(), false, 'Should not be watching initially');

            watcher.start(testFile);
            assert.strictEqual(watcher.isWatching(), true, 'Should be watching after start');

            watcher.stop();
            assert.strictEqual(watcher.isWatching(), false, 'Should not be watching after stop');
        });

        test('should handle multiple start/stop cycles', () => {
            for (let i = 0; i < 3; i++) {
                watcher.start(testFile);
                assert.strictEqual(watcher.isWatching(), true);
                watcher.stop();
                assert.strictEqual(watcher.isWatching(), false);
            }
        });

        test('should handle start when already watching', () => {
            watcher.start(testFile);
            assert.strictEqual(watcher.isWatching(), true);

            // Start again - should not throw
            watcher.start(testFile);
            assert.strictEqual(watcher.isWatching(), true);

            watcher.stop();
        });
    });

    /**
     * Debounce behavior
     */
    suite('Debounce Behavior', () => {
        test('should debounce rapid changes', (done) => {
            let changeCount = 0;

            watcher.on('change', () => {
                changeCount++;
            });

            watcher.start(testFile);

            // Make multiple rapid changes
            setTimeout(() => {
                for (let i = 0; i < 5; i++) {
                    fs.writeFileSync(testFile, `{"count": ${i}}`, 'utf-8');
                }
            }, 100);

            // After debounce period, should have received only 1-2 events
            setTimeout(() => {
                assert.ok(changeCount >= 1, 'Should have at least one change');
                assert.ok(changeCount <= 3, 'Should have debounced multiple changes');
                done();
            }, 1000);
        });
    });

    /**
     * Event listener management
     */
    suite('Event Listener Management', () => {
        test('should support multiple listeners', (done) => {
            let listener1Called = false;
            let listener2Called = false;

            const listener1 = () => { listener1Called = true; };
            const listener2 = () => { listener2Called = true; };

            watcher.on('change', listener1);
            watcher.on('change', listener2);

            watcher.start(testFile);

            setTimeout(() => {
                fs.writeFileSync(testFile, '{"multi": true}', 'utf-8');
            }, 100);

            setTimeout(() => {
                assert.strictEqual(listener1Called, true, 'Listener 1 should be called');
                assert.strictEqual(listener2Called, true, 'Listener 2 should be called');
                done();
            }, 500);
        });

        test('should allow removing listeners', (done) => {
            let callCount = 0;

            const listener = () => { callCount++; };

            watcher.on('change', listener);
            watcher.off('change', listener);

            watcher.start(testFile);

            setTimeout(() => {
                fs.writeFileSync(testFile, '{"removed": true}', 'utf-8');
            }, 100);

            setTimeout(() => {
                assert.strictEqual(callCount, 0, 'Removed listener should not be called');
                done();
            }, 500);
        });
    });

    /**
     * Error handling
     */
    suite('Error Handling', () => {
        test('should handle non-existent file gracefully', () => {
            const nonExistentFile = path.join(testDir, 'non-existent.json');

            // Should not throw
            watcher.start(nonExistentFile);
            assert.strictEqual(watcher.isWatching(), true);

            watcher.stop();
        });

        test('should handle deleted file during watch', (done) => {
            watcher.start(testFile);

            // Delete the file while watching
            setTimeout(() => {
                fs.unlinkSync(testFile);
            }, 100);

            // Should not crash
            setTimeout(() => {
                // Watcher may or may not still be active depending on OS
                done();
            }, 500);
        });
    });

    /**
     * Platform compatibility note:
     * fs.watch behavior varies across platforms (Windows, macOS, Linux).
     * These tests use generous timeouts to account for differences.
     */
});
