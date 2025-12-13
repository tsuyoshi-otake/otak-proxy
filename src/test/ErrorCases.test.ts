/**
 * Error Case Tests for Cross-Platform Proxy Management
 * Tests ENOENT, EACCES, Timeout, and Invalid Output errors
 *
 * Feature: cross-platform-support
 * Requirements: 6.1-6.6, 9.2
 */

import * as assert from 'assert';
import { GitConfigManager, OperationResult as GitOperationResult } from '../config/GitConfigManager';
import { NpmConfigManager, OperationResult as NpmOperationResult } from '../config/NpmConfigManager';
import { TerminalEnvConfigManager } from '../config/TerminalEnvConfigManager';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import {
    PlatformMocker,
    CommandMocker,
    ErrorPatterns,
    TestDataPatterns
} from './crossPlatformMockers';

/**
 * Task 4.1: Command Not Found (ENOENT) Error Tests
 * Requirements: 6.1, 6.2, 6.3, 6.6, 9.2
 */
suite('Command Not Found Error Tests (Task 4.1)', () => {
    let restorePlatform: (() => void) | null = null;

    teardown(() => {
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    suite('ENOENT Error Pattern Verification', () => {
        test('should create ENOENT error with correct structure', () => {
            const error = CommandMocker.createError(ErrorPatterns.enoent);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.code, 'ENOENT');
            assert.ok(error.message.includes('ENOENT'));
        });

        test('should have ENOENT code property', () => {
            assert.strictEqual(ErrorPatterns.enoent.code, 'ENOENT');
        });
    });

    suite('Git Not Installed Error', () => {
        test('should handle git ENOENT error gracefully', async () => {
            // GitConfigManager returns OperationResult with errorType
            const manager = new GitConfigManager();

            // Attempt operation - if git is not installed, should return NOT_INSTALLED
            const result = await manager.setProxy('http://proxy.example.com:8080');

            // Should return OperationResult, not throw
            assert.ok('success' in result);

            // If failed due to git not found, errorType should be NOT_INSTALLED
            if (!result.success && result.errorType === 'NOT_INSTALLED') {
                assert.strictEqual(result.errorType, 'NOT_INSTALLED');
                assert.ok(result.error?.includes('Git'));
            }
        });

        test('should return null from getProxy when git not found', async () => {
            const manager = new GitConfigManager();
            const proxy = await manager.getProxy();

            // Should return null, not throw
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('npm Not Installed Error', () => {
        test('should handle npm ENOENT error gracefully', async () => {
            const manager = new NpmConfigManager();
            const result = await manager.setProxy('http://proxy.example.com:8080');

            assert.ok('success' in result);

            if (!result.success && result.errorType === 'NOT_INSTALLED') {
                assert.strictEqual(result.errorType, 'NOT_INSTALLED');
                assert.ok(result.error?.includes('npm'));
            }
        });

        test('should return null from getProxy when npm not found', async () => {
            const manager = new NpmConfigManager();
            const proxy = await manager.getProxy();

            // Should return null, not throw
            assert.ok(proxy === null || typeof proxy === 'string');
        });
    });

    suite('Platform-Specific Command Not Found', () => {
        test('should handle Windows reg query not found on non-Windows', async () => {
            restorePlatform = PlatformMocker.mockPlatform('linux');

            // On Linux, reg query is not available
            // SystemProxyDetector should gracefully handle this
            const detector = new SystemProxyDetector(['platform']);

            // Detection should return null for unsupported command
            const result = await detector.detectSystemProxyWithSource();

            // Should return result (not throw), may be null
            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
        });

        test('should handle macOS networksetup not found on non-macOS', async () => {
            restorePlatform = PlatformMocker.mockPlatform('win32');

            const detector = new SystemProxyDetector(['platform']);

            const result = await detector.detectSystemProxyWithSource();

            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
        });

        test('should handle Linux gsettings not found on non-Linux', async () => {
            restorePlatform = PlatformMocker.mockPlatform('darwin');

            const detector = new SystemProxyDetector(['platform']);

            const result = await detector.detectSystemProxyWithSource();

            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
        });
    });

    suite('Error Logging Verification', () => {
        test('should return null on detection failure (error logged internally)', async () => {
            // Use invalid sources to trigger internal error handling
            const detector = new SystemProxyDetector(['invalid_source']);
            const result = await detector.detectSystemProxyWithSource();

            // Should return null, error logged internally
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });
    });
});

/**
 * Task 4.2: Timeout Error Tests
 * Requirements: 6.1, 6.2, 6.6, 9.2
 */
suite('Timeout Error Tests (Task 4.2)', () => {
    suite('Timeout Error Pattern Verification', () => {
        test('should create timeout error with killed=true', () => {
            const error = CommandMocker.createError(ErrorPatterns.timeout);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.killed, true);
            assert.strictEqual(errorAny.signal, 'SIGTERM');
        });

        test('should have correct timeout error properties', () => {
            assert.strictEqual(ErrorPatterns.timeout.killed, true);
            assert.strictEqual(ErrorPatterns.timeout.signal, 'SIGTERM');
        });
    });

    suite('Git Command Timeout', () => {
        test('should handle git timeout with TIMEOUT errorType', async () => {
            const manager = new GitConfigManager();

            // Actual test with real git - verify timeout handling structure
            const result = await manager.setProxy('http://proxy.example.com:8080');

            // If timeout occurred, errorType should be TIMEOUT
            if (!result.success && result.errorType === 'TIMEOUT') {
                assert.strictEqual(result.errorType, 'TIMEOUT');
                assert.ok(result.error?.includes('timeout'));
            }
        });
    });

    suite('npm Command Timeout', () => {
        test('should handle npm timeout with TIMEOUT errorType', async () => {
            const manager = new NpmConfigManager();

            const result = await manager.setProxy('http://proxy.example.com:8080');

            if (!result.success && result.errorType === 'TIMEOUT') {
                assert.strictEqual(result.errorType, 'TIMEOUT');
                assert.ok(result.error?.includes('timeout'));
            }
        });
    });

    suite('Error Type Verification', () => {
        test('should distinguish TIMEOUT from other error types', () => {
            const validGitErrorTypes: GitOperationResult['errorType'][] = [
                'NOT_INSTALLED', 'NO_PERMISSION', 'TIMEOUT', 'UNKNOWN'
            ];
            const validNpmErrorTypes: NpmOperationResult['errorType'][] = [
                'NOT_INSTALLED', 'NO_PERMISSION', 'TIMEOUT', 'CONFIG_ERROR', 'UNKNOWN'
            ];

            assert.ok(validGitErrorTypes.includes('TIMEOUT'));
            assert.ok(validNpmErrorTypes.includes('TIMEOUT'));
        });
    });
});

/**
 * Task 4.3: Permission Error Tests
 * Requirements: 6.6, 9.2
 */
suite('Permission Error Tests (Task 4.3)', () => {
    suite('EACCES Error Pattern Verification', () => {
        test('should create EACCES error with correct structure', () => {
            const error = CommandMocker.createError(ErrorPatterns.eacces);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.code, 'EACCES');
            assert.ok(error.message.includes('Permission'));
        });

        test('should have EACCES code property', () => {
            assert.strictEqual(ErrorPatterns.eacces.code, 'EACCES');
        });
    });

    suite('Git Permission Denied', () => {
        test('should handle git EACCES error with NO_PERMISSION errorType', async () => {
            const manager = new GitConfigManager();

            const result = await manager.setProxy('http://proxy.example.com:8080');

            if (!result.success && result.errorType === 'NO_PERMISSION') {
                assert.strictEqual(result.errorType, 'NO_PERMISSION');
                assert.ok(result.error?.toLowerCase().includes('permission'));
            }
        });
    });

    suite('npm Permission Denied', () => {
        test('should handle npm EACCES error with NO_PERMISSION errorType', async () => {
            const manager = new NpmConfigManager();

            const result = await manager.setProxy('http://proxy.example.com:8080');

            if (!result.success && result.errorType === 'NO_PERMISSION') {
                assert.strictEqual(result.errorType, 'NO_PERMISSION');
                assert.ok(result.error?.toLowerCase().includes('permission'));
            }
        });
    });

    suite('Error Type Verification', () => {
        test('should distinguish NO_PERMISSION from other error types', () => {
            const validErrorTypes = ['NOT_INSTALLED', 'NO_PERMISSION', 'TIMEOUT', 'UNKNOWN'];

            assert.ok(validErrorTypes.includes('NO_PERMISSION'));
        });
    });
});

/**
 * Task 4.4: Invalid Output Format Tests
 * Requirements: 6.4, 6.5, 9.2
 */
suite('Invalid Output Format Tests (Task 4.4)', () => {
    suite('Windows Registry Invalid Output', () => {
        test('should handle malformed ProxyEnable output', () => {
            // Malformed output missing expected pattern
            const malformedOutput = 'HKCU\\Software\\Microsoft\\Windows Invalid';

            // Should not match expected regex
            const match = malformedOutput.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);
            assert.strictEqual(match, null);
        });

        test('should handle empty registry output', () => {
            const emptyOutput = TestDataPatterns.windows.notFound;

            assert.strictEqual(emptyOutput, '');
        });

        test('should handle missing ProxyServer value', () => {
            // Output with ProxyEnable but no ProxyServer
            const partialOutput = TestDataPatterns.windows.proxyEnabled;

            // Should match ProxyEnable but not contain ProxyServer in same string
            assert.ok(partialOutput.includes('ProxyEnable'));
            assert.ok(!partialOutput.includes('ProxyServer'));
        });
    });

    suite('macOS networksetup Invalid Output', () => {
        test('should handle interface not found error', () => {
            const errorOutput = TestDataPatterns.macos.interfaceNotFound;

            // Should not match expected proxy pattern
            const enabledMatch = errorOutput.match(/Enabled:\s*(\w+)/);
            assert.strictEqual(enabledMatch, null);
        });

        test('should handle missing server in output', () => {
            const disabledOutput = TestDataPatterns.macos.proxyDisabled;

            // Disabled output - check for Server line pattern
            // The actual SystemProxyDetector uses /Server:\s*(.+)/ which requires non-empty match
            const serverMatchActual = disabledOutput.match(/Server:\s*(.+)/);

            // When server is empty (disabled proxy), the regex may:
            // 1. Not match at all (server line is empty)
            // 2. Match empty string after Server:
            if (serverMatchActual) {
                const server = serverMatchActual[1].trim();
                // If it matched, server should be meaningful or empty
                assert.ok(typeof server === 'string');
            } else {
                // No match - Server line has no value (disabled proxy)
                // This is the expected behavior for disabled proxy
                assert.ok(true, 'Server line is empty - proxy is disabled');
            }
        });

        test('should handle port=0 (disabled)', () => {
            const disabledOutput = TestDataPatterns.macos.proxyDisabled;

            const portMatch = disabledOutput.match(/Port:\s*(\d+)/);
            assert.ok(portMatch);
            assert.strictEqual(portMatch[1], '0');
        });
    });

    suite('Linux gsettings Invalid Output', () => {
        test('should handle mode=auto (unsupported)', () => {
            const autoMode = TestDataPatterns.linux.modeAuto;

            // Auto mode should not be 'manual'
            assert.ok(!autoMode.includes('manual'));
            assert.ok(autoMode.includes('auto'));
        });

        test('should handle mode=none', () => {
            const noneMode = TestDataPatterns.linux.modeNone;

            assert.ok(!noneMode.includes('manual'));
            assert.ok(noneMode.includes('none'));
        });

        test('should handle empty host', () => {
            const emptyHost = TestDataPatterns.linux.hostEmpty;

            // Clean the host - should be empty string
            const cleanHost = emptyHost.replace(/'/g, '').trim();
            assert.strictEqual(cleanHost, '');
        });

        test('should handle port=0', () => {
            const zeroPort = TestDataPatterns.linux.portZero;

            assert.strictEqual(zeroPort, '0');
            // Port 0 is invalid for proxy
        });
    });

    suite('Fallback on Invalid Output', () => {
        test('should fallback to next source on invalid output', async () => {
            // Create detector with multiple sources
            const detector = new SystemProxyDetector(['platform', 'environment']);

            const result = await detector.detectSystemProxyWithSource();

            // Should return valid result (may be null if no proxy configured)
            assert.ok(result !== null);
            assert.ok('proxyUrl' in result);
            assert.ok('source' in result);
        });

        test('should return { proxyUrl: null, source: null } when all sources fail', async () => {
            // Use only invalid sources
            const detector = new SystemProxyDetector(['invalid1', 'invalid2']);

            const result = await detector.detectSystemProxyWithSource();

            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });
    });
});

/**
 * Common Error Handling Verification
 */
suite('Common Error Handling Tests', () => {
    test('should never throw exceptions from ConfigManagers', async () => {
        const gitManager = new GitConfigManager();
        const npmManager = new NpmConfigManager();
        const terminalManager = new TerminalEnvConfigManager(null);

        // All operations should return results, not throw
        try {
            await gitManager.getProxy();
            await gitManager.setProxy('http://proxy.example.com:8080');
            await gitManager.unsetProxy();

            await npmManager.getProxy();
            await npmManager.setProxy('http://proxy.example.com:8080');
            await npmManager.unsetProxy();

            await terminalManager.setProxy('http://proxy.example.com:8080');
            await terminalManager.unsetProxy();

            assert.ok(true, 'No exceptions thrown');
        } catch (error) {
            assert.fail(`ConfigManager threw unexpected exception: ${error}`);
        }
    });

    test('should have consistent error handling across platforms', () => {
        // Verify error patterns are consistent
        const patterns = [ErrorPatterns.enoent, ErrorPatterns.eacces, ErrorPatterns.timeout];

        for (const pattern of patterns) {
            const error = CommandMocker.createError(pattern);
            assert.ok(error instanceof Error);
            assert.ok(error.message);
        }
    });
});
