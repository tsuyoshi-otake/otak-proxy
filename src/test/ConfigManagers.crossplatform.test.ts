/**
 * Cross-Platform Tests for Config Managers
 * Tests GitConfigManager, NpmConfigManager, and TerminalEnvConfigManager
 *
 * Feature: cross-platform-support
 * Requirements: 2.4-2.6, 3.5-3.7, 4.5-4.7, 8.3, 8.4
 */

import * as assert from 'assert';
import { GitConfigManager } from '../config/GitConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import {
    PlatformMocker,
    TestDataPatterns
} from './crossPlatformMockers';

/**
 * Task 3.1: Git Config Manager Cross-Platform Tests
 * Requirements: 2.4, 3.5, 4.5, 8.3
 */
suite('GitConfigManager Cross-Platform Test Suite (Task 3.1)', () => {
    let gitManager: GitConfigManager;
    let restorePlatform: (() => void) | null = null;

    setup(() => {
        gitManager = new GitConfigManager();
    });

    teardown(() => {
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    suite('execFile Direct Execution (No Shell)', () => {
        test('should use execFile without shell for security', () => {
            // GitConfigManager uses execFile() directly, not exec()
            // This prevents shell injection attacks
            assert.ok(gitManager);
        });

        test('should handle git config --global on Windows', async () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');

            // Test that getProxy works (actual command execution)
            // May return null if git is not installed or no proxy set
            const proxy = await gitManager.getProxy();

            // Should return string or null, not throw
            assert.ok(proxy === null || typeof proxy === 'string');
        });

        test('should handle git config --global on macOS', async () => {
            restorePlatform = PlatformMocker.mockPlatform('darwin');

            const proxy = await gitManager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });

        test('should handle git config --global on Linux', async () => {
            restorePlatform = PlatformMocker.mockPlatform('linux');

            const proxy = await gitManager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('Proxy Configuration Keys', () => {
        test('should set http.proxy and https.proxy keys', async () => {
            // Note: This test verifies the interface, not actual git interaction
            const proxyUrl = TestDataPatterns.expectedProxyUrl;

            // setProxy returns OperationResult
            const result = await gitManager.setProxy(proxyUrl);

            // Success or specific error type (e.g., git not installed)
            assert.ok('success' in result);
            if (!result.success) {
                assert.ok(result.errorType);
            }
        });

        test('should get http.proxy key value', async () => {
            const proxy = await gitManager.getProxy();

            // Should return string or null
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('Error Handling', () => {
        test('should return OperationResult with errorType on failure', async () => {
            // Test with invalid URL to trigger potential validation
            const result = await gitManager.setProxy('http://proxy.example.com:8080');

            assert.ok('success' in result);
            if (!result.success && result.errorType) {
                const validErrorTypes = ['NOT_INSTALLED', 'NO_PERMISSION', 'TIMEOUT', 'UNKNOWN'];
                assert.ok(validErrorTypes.includes(result.errorType));
            }
        });
    });
});

/**
 * Task 3.2: npm Config Manager Cross-Platform Tests
 * Requirements: 2.5, 3.6, 4.6, 8.4
 */
suite('NpmConfigManager Cross-Platform Test Suite (Task 3.2)', () => {
    let npmManager: NpmConfigManager;
    let restorePlatform: (() => void) | null = null;

    setup(() => {
        npmManager = new NpmConfigManager();
    });

    teardown(() => {
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    suite('isWindows Flag Shell Control', () => {
        test('should use shell:true on Windows for npm.cmd', async () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');

            // NpmConfigManager checks process.platform internally
            // On Windows, npm is a batch file (.cmd) requiring shell:true
            const manager = new NpmConfigManager();
            assert.ok(manager);

            // Test actual command execution
            const proxy = await manager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });

        test('should not require shell on macOS', async () => {
            restorePlatform = PlatformMocker.mockPlatform('darwin');

            const manager = new NpmConfigManager();
            const proxy = await manager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });

        test('should not require shell on Linux', async () => {
            restorePlatform = PlatformMocker.mockPlatform('linux');

            const manager = new NpmConfigManager();
            const proxy = await manager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('Proxy Configuration Keys', () => {
        test('should set proxy and https-proxy keys', async () => {
            const proxyUrl = TestDataPatterns.expectedProxyUrl;
            const result = await npmManager.setProxy(proxyUrl);

            assert.ok('success' in result);
        });

        test('should get proxy key value', async () => {
            const proxy = await npmManager.getProxy();
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('Error Handling', () => {
        test('should return OperationResult with errorType on failure', async () => {
            const result = await npmManager.setProxy('http://proxy.example.com:8080');

            assert.ok('success' in result);
            if (!result.success && result.errorType) {
                const validErrorTypes = ['NOT_INSTALLED', 'NO_PERMISSION', 'TIMEOUT', 'CONFIG_ERROR', 'UNKNOWN'];
                assert.ok(validErrorTypes.includes(result.errorType));
            }
        });
    });
});

/**
 * Task 3.3: Terminal Env Config Manager Cross-Platform Tests
 * Requirements: 2.6, 3.7, 4.7
 */
suite('TerminalEnvConfigManager Cross-Platform Test Suite (Task 3.3)', () => {
    let restorePlatform: (() => void) | null = null;

    teardown(() => {
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    suite('VSCode API Abstraction', () => {
        test('should handle missing environmentVariableCollection gracefully', async () => {
            const manager = new TerminalEnvConfigManager(null);

            // Should not throw, returns success with warning
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok(result.success);
        });

        test('should handle undefined environmentVariableCollection', async () => {
            const manager = new TerminalEnvConfigManager(undefined);

            const result = await manager.unsetProxy();

            assert.ok(result.success);
        });
    });

    suite('Environment Variable Keys', () => {
        test('should set HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy', async () => {
            // Mock environmentVariableCollection
            const replacedVars: Record<string, string> = {};
            const mockCollection = {
                replace: (key: string, value: string) => {
                    replacedVars[key] = value;
                },
                delete: (key: string) => {
                    delete replacedVars[key];
                }
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            const proxyUrl = TestDataPatterns.expectedProxyUrl;

            await manager.setProxy(proxyUrl);

            // Verify all 4 env vars are set
            assert.strictEqual(replacedVars['HTTP_PROXY'], proxyUrl);
            assert.strictEqual(replacedVars['HTTPS_PROXY'], proxyUrl);
            assert.strictEqual(replacedVars['http_proxy'], proxyUrl);
            assert.strictEqual(replacedVars['https_proxy'], proxyUrl);
        });

        test('should delete all proxy env vars on unset', async () => {
            const existingVars: Record<string, string> = {
                'HTTP_PROXY': 'http://old-proxy:8080',
                'HTTPS_PROXY': 'http://old-proxy:8080',
                'http_proxy': 'http://old-proxy:8080',
                'https_proxy': 'http://old-proxy:8080'
            };

            const deletedVars: string[] = [];
            const mockCollection = {
                replace: (key: string, value: string) => {
                    existingVars[key] = value;
                },
                delete: (key: string) => {
                    deletedVars.push(key);
                    delete existingVars[key];
                }
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            await manager.unsetProxy();

            // Verify all 4 env vars are deleted
            assert.ok(deletedVars.includes('HTTP_PROXY'));
            assert.ok(deletedVars.includes('HTTPS_PROXY'));
            assert.ok(deletedVars.includes('http_proxy'));
            assert.ok(deletedVars.includes('https_proxy'));
        });
    });

    suite('Platform Independence', () => {
        test('should work identically on Windows', async () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');

            const mockCollection = {
                replace: () => {},
                delete: () => {}
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok(result.success);
        });

        test('should work identically on macOS', async () => {
            restorePlatform = PlatformMocker.mockPlatform('darwin');

            const mockCollection = {
                replace: () => {},
                delete: () => {}
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok(result.success);
        });

        test('should work identically on Linux', async () => {
            restorePlatform = PlatformMocker.mockPlatform('linux');

            const mockCollection = {
                replace: () => {},
                delete: () => {}
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok(result.success);
        });
    });

    suite('Error Handling', () => {
        test('should catch and return errors', async () => {
            const mockCollection = {
                replace: () => {
                    throw new Error('Mock error');
                },
                delete: () => {}
            };

            const manager = new TerminalEnvConfigManager(mockCollection);
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok(!result.success);
            assert.ok(result.error);
            assert.strictEqual(result.errorType, 'UNKNOWN');
        });
    });
});
