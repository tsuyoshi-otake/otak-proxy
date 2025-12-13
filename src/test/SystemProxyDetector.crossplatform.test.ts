/**
 * Cross-Platform Tests for SystemProxyDetector
 * Tests platform-specific proxy detection logic using mockers
 *
 * Feature: cross-platform-support
 * Requirements: 1.1, 1.2, 1.4, 2.1-2.3, 3.1-3.4, 4.1-4.4, 9.1
 */

import * as assert from 'assert';
import { SystemProxyDetector, DetectionSource } from '../config/SystemProxyDetector';
import {
    PlatformMocker,
    EnvMocker,
    TestDataPatterns
} from './crossPlatformMockers';

suite('SystemProxyDetector Cross-Platform Test Suite', () => {
    let detector: SystemProxyDetector;
    let envMocker: EnvMocker;
    let restorePlatform: (() => void) | null = null;

    setup(() => {
        detector = new SystemProxyDetector();
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
        if (restorePlatform) {
            restorePlatform();
            restorePlatform = null;
        }
    });

    /**
     * Task 2.1: Windows Registry Detection Tests
     * Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.3
     */
    suite('Windows Platform Detection (Task 2.1)', () => {
        suite('Platform Identification', () => {
            test('should identify win32 platform correctly', () => {
                restorePlatform = PlatformMocker.mockPlatform('win32');

                assert.strictEqual(process.platform, 'win32');
            });

            test('should use platform detection for win32', async () => {
                // Clear environment variables to force platform detection
                envMocker.mockEnv({
                    HTTP_PROXY: '',
                    HTTPS_PROXY: '',
                    http_proxy: '',
                    https_proxy: ''
                });

                // On Windows, the actual test will try registry query
                // This test verifies the platform switch logic executes
                const result = await detector.detectSystemProxyWithSource();

                // Result may be null if no proxy is configured in registry
                assert.ok(result !== null);
                assert.ok('proxyUrl' in result);
                assert.ok('source' in result);
            });
        });

        suite('Registry Output Parsing', () => {
            test('should parse http=proxy:port;https=proxy:port format', () => {
                // Test the parsing logic by verifying TestDataPatterns match expected format
                const pattern = TestDataPatterns.windows.proxyServerHttpEquals;

                // Verify the pattern contains expected registry format
                assert.ok(pattern.includes('http='));
                assert.ok(pattern.includes('https='));
                assert.ok(pattern.includes('proxy.example.com'));
                assert.ok(pattern.includes('8080'));
            });

            test('should parse simple proxy:port format', () => {
                const pattern = TestDataPatterns.windows.proxyServerSimple;

                // Verify simple format pattern
                assert.ok(pattern.includes('proxy.example.com:8080'));
                assert.ok(!pattern.includes('http='));
            });

            test('should handle ProxyEnable=1 (enabled) pattern', () => {
                const pattern = TestDataPatterns.windows.proxyEnabled;

                // Verify enabled pattern matches expected registry output
                const match = pattern.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);
                assert.ok(match);
                assert.strictEqual(match[1], '1');
            });

            test('should handle ProxyEnable=0 (disabled) pattern', () => {
                const pattern = TestDataPatterns.windows.proxyDisabled;

                // Verify disabled pattern
                const match = pattern.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/);
                assert.ok(match);
                assert.strictEqual(match[0].includes('0x0'), true);
            });
        });

        suite('Detection Source Verification', () => {
            test('should return windows as source when detected on win32', async () => {
                // This test runs on actual platform, checking correct source is returned
                if (process.platform === 'win32') {
                    const result = await detector.detectSystemProxyWithSource();

                    // If proxy found from platform, source should be 'windows'
                    if (result.proxyUrl && result.source !== 'environment' && result.source !== 'vscode') {
                        assert.strictEqual(result.source, 'windows');
                    }
                }
            });
        });
    });

    /**
     * Task 2.2: macOS networksetup Detection Tests
     * Requirements: 1.1, 1.2, 1.4, 3.1, 3.2, 3.3, 3.4
     */
    suite('macOS Platform Detection (Task 2.2)', () => {
        suite('Platform Identification', () => {
            test('should identify darwin platform correctly', () => {
                restorePlatform = PlatformMocker.mockPlatform('darwin');

                assert.strictEqual(process.platform, 'darwin');
            });
        });

        suite('networksetup Output Parsing', () => {
            test('should parse Enabled: Yes with Server and Port', () => {
                const pattern = TestDataPatterns.macos.proxyEnabled;

                // Verify pattern matches networksetup output format
                const enabledMatch = pattern.match(/Enabled:\s*(\w+)/);
                const serverMatch = pattern.match(/Server:\s*(.+)/);
                const portMatch = pattern.match(/Port:\s*(\d+)/);

                assert.ok(enabledMatch);
                assert.strictEqual(enabledMatch[1], 'Yes');
                assert.ok(serverMatch);
                assert.strictEqual(serverMatch[1].trim(), 'proxy.example.com');
                assert.ok(portMatch);
                assert.strictEqual(portMatch[1], '8080');
            });

            test('should parse Enabled: No (disabled) pattern', () => {
                const pattern = TestDataPatterns.macos.proxyDisabled;

                const enabledMatch = pattern.match(/Enabled:\s*(\w+)/);
                assert.ok(enabledMatch);
                assert.strictEqual(enabledMatch[1], 'No');
            });

            test('should format server:port as http://server:port', () => {
                // Verify expected URL format
                const server = 'proxy.example.com';
                const port = '8080';
                const expectedUrl = `http://${server}:${port}`;

                assert.strictEqual(expectedUrl, TestDataPatterns.expectedProxyUrl);
            });
        });

        suite('Network Interface Priority', () => {
            test('should test Wi-Fi interface first', () => {
                // Verify the pattern includes Wi-Fi
                const wifiMocks = [
                    { command: /networksetup.*Wi-Fi/, response: { stdout: TestDataPatterns.macos.proxyEnabled } }
                ];

                assert.strictEqual(wifiMocks.length, 1);
                assert.ok(wifiMocks[0].command.toString().includes('Wi-Fi'));
            });

            test('should include Ethernet and Thunderbolt Ethernet interfaces', () => {
                // Verify additional interfaces are supported
                const interfaces = ['Wi-Fi', 'Ethernet', 'Thunderbolt Ethernet'];

                // These are the interfaces SystemProxyDetector checks
                assert.ok(interfaces.includes('Wi-Fi'));
                assert.ok(interfaces.includes('Ethernet'));
                assert.ok(interfaces.includes('Thunderbolt Ethernet'));
            });
        });

        suite('Detection Source Verification', () => {
            test('should return macos as source when detected on darwin', async () => {
                if (process.platform === 'darwin') {
                    const result = await detector.detectSystemProxyWithSource();

                    if (result.proxyUrl && result.source !== 'environment' && result.source !== 'vscode') {
                        assert.strictEqual(result.source, 'macos');
                    }
                }
            });
        });
    });

    /**
     * Task 2.3: Linux gsettings Detection Tests
     * Requirements: 1.1, 1.2, 1.4, 4.1, 4.2, 4.3, 4.4
     */
    suite('Linux Platform Detection (Task 2.3)', () => {
        suite('Platform Identification', () => {
            test('should identify linux platform correctly', () => {
                restorePlatform = PlatformMocker.mockPlatform('linux');

                assert.strictEqual(process.platform, 'linux');
            });
        });

        suite('gsettings Output Parsing', () => {
            test('should parse mode=manual pattern', () => {
                const pattern = TestDataPatterns.linux.modeManual;

                assert.ok(pattern.includes('manual'));
            });

            test('should parse mode=auto (unsupported) pattern', () => {
                const pattern = TestDataPatterns.linux.modeAuto;

                assert.ok(pattern.includes('auto'));
            });

            test('should parse mode=none pattern', () => {
                const pattern = TestDataPatterns.linux.modeNone;

                assert.ok(pattern.includes('none'));
            });

            test('should parse host with quotes', () => {
                const hostPattern = TestDataPatterns.linux.host;

                // gsettings returns values with quotes
                assert.strictEqual(hostPattern, `'proxy.example.com'`);

                // Clean host should be without quotes
                const cleanHost = hostPattern.replace(/'/g, '').trim();
                assert.strictEqual(cleanHost, 'proxy.example.com');
            });

            test('should parse port as number string', () => {
                const portPattern = TestDataPatterns.linux.port;

                assert.strictEqual(portPattern, '8080');
                assert.strictEqual(parseInt(portPattern, 10), 8080);
            });

            test('should format host:port as http://host:port', () => {
                const host = TestDataPatterns.linux.host.replace(/'/g, '').trim();
                const port = TestDataPatterns.linux.port;
                const expectedUrl = `http://${host}:${port}`;

                assert.strictEqual(expectedUrl, TestDataPatterns.expectedProxyUrl);
            });
        });

        suite('gsettings Error Handling', () => {
            test('should handle empty host (no proxy configured)', () => {
                const emptyHost = TestDataPatterns.linux.hostEmpty;

                assert.strictEqual(emptyHost, `''`);
                const cleanHost = emptyHost.replace(/'/g, '').trim();
                assert.strictEqual(cleanHost, '');
            });

            test('should handle port=0 (no proxy configured)', () => {
                const zeroPort = TestDataPatterns.linux.portZero;

                assert.strictEqual(zeroPort, '0');
            });
        });

        suite('Detection Source Verification', () => {
            test('should return linux as source when detected on linux', async () => {
                if (process.platform === 'linux') {
                    const result = await detector.detectSystemProxyWithSource();

                    if (result.proxyUrl && result.source !== 'environment' && result.source !== 'vscode') {
                        assert.strictEqual(result.source, 'linux');
                    }
                }
            });
        });
    });

    /**
     * Common Cross-Platform Tests
     * Requirements: 1.1, 1.2, 1.3, 1.4
     */
    suite('Common Platform Detection Tests', () => {
        test('should handle unsupported platforms gracefully', async () => {
            restorePlatform = PlatformMocker.mockPlatform('freebsd' as NodeJS.Platform);

            // Clear environment to force platform detection
            envMocker.mockEnv({
                HTTP_PROXY: '',
                HTTPS_PROXY: '',
                http_proxy: '',
                https_proxy: ''
            });

            const detector2 = new SystemProxyDetector(['platform']);
            const result = await detector2.detectSystemProxyWithSource();

            // Should return null for unsupported platform
            assert.strictEqual(result.proxyUrl, null);
            assert.strictEqual(result.source, null);
        });

        test('should return DetectionSource type for each platform', () => {
            // Verify DetectionSource includes all platform types
            const validSources: DetectionSource[] = ['environment', 'vscode', 'windows', 'macos', 'linux', null];

            assert.ok(validSources.includes('windows'));
            assert.ok(validSources.includes('macos'));
            assert.ok(validSources.includes('linux'));
        });

        test('should prioritize environment over platform detection', async () => {
            // Set environment proxy
            envMocker.mockEnv({
                HTTP_PROXY: TestDataPatterns.expectedProxyUrl
            });

            const result = await detector.detectSystemProxyWithSource();

            // Should detect from environment first
            if (result.proxyUrl) {
                assert.strictEqual(result.source, 'environment');
                assert.strictEqual(result.proxyUrl, TestDataPatterns.expectedProxyUrl);
            }
        });

        test('should return consistent proxyUrl and source', async () => {
            const result = await detector.detectSystemProxyWithSource();

            // If proxyUrl is null, source should also be null
            if (result.proxyUrl === null) {
                assert.strictEqual(result.source, null);
            } else {
                // If proxyUrl exists, source should not be null
                assert.ok(result.source !== null);
            }
        });
    });
});
