/**
 * Unit tests for Cross-Platform Mocking Utilities
 * Tests PlatformMocker, EnvMocker, and test data patterns
 *
 * Feature: cross-platform-support
 * Requirements: 9.1, 9.2, 9.4
 */

import * as assert from 'assert';
import {
    PlatformMocker,
    EnvMocker,
    TestDataPatterns,
    ErrorPatterns,
    CommandMocker,
    createTestSandbox
} from './crossPlatformMockers';

suite('PlatformMocker Test Suite', () => {
    /**
     * Task 1.1: PlatformMocker tests
     * Requirements: 9.4
     */

    suite('mockPlatform', () => {
        test('should mock process.platform to win32', () => {
            const originalPlatform = process.platform;

            const restore = PlatformMocker.mockPlatform('win32');

            try {
                assert.strictEqual(process.platform, 'win32');
            } finally {
                restore();
                assert.strictEqual(process.platform, originalPlatform);
            }
        });

        test('should mock process.platform to darwin', () => {
            const originalPlatform = process.platform;

            const restore = PlatformMocker.mockPlatform('darwin');

            try {
                assert.strictEqual(process.platform, 'darwin');
            } finally {
                restore();
                assert.strictEqual(process.platform, originalPlatform);
            }
        });

        test('should mock process.platform to linux', () => {
            const originalPlatform = process.platform;

            const restore = PlatformMocker.mockPlatform('linux');

            try {
                assert.strictEqual(process.platform, 'linux');
            } finally {
                restore();
                assert.strictEqual(process.platform, originalPlatform);
            }
        });

        test('should restore original platform value after restore()', () => {
            const originalPlatform = process.platform;

            const restore = PlatformMocker.mockPlatform('darwin');
            assert.strictEqual(process.platform, 'darwin');

            restore();
            assert.strictEqual(process.platform, originalPlatform);
        });

        test('should allow multiple sequential mocks with proper restoration', () => {
            const originalPlatform = process.platform;

            // First mock
            const restore1 = PlatformMocker.mockPlatform('win32');
            assert.strictEqual(process.platform, 'win32');
            restore1();

            // Second mock
            const restore2 = PlatformMocker.mockPlatform('linux');
            assert.strictEqual(process.platform, 'linux');
            restore2();

            assert.strictEqual(process.platform, originalPlatform);
        });

        test('should isolate state between different mock calls', () => {
            const originalPlatform = process.platform;

            const restore1 = PlatformMocker.mockPlatform('darwin');
            assert.strictEqual(process.platform, 'darwin');

            // Restore and verify isolation
            restore1();

            const restore2 = PlatformMocker.mockPlatform('win32');
            assert.strictEqual(process.platform, 'win32');

            restore2();
            assert.strictEqual(process.platform, originalPlatform);
        });
    });
});

suite('EnvMocker Test Suite', () => {
    /**
     * Task 1.2: EnvMocker tests (part of CommandMocker functionality)
     * Requirements: 9.1
     */

    let envMocker: EnvMocker;

    setup(() => {
        envMocker = new EnvMocker();
    });

    teardown(() => {
        envMocker.restore();
    });

    test('should mock environment variables', () => {
        const originalValue = process.env.HTTP_PROXY;

        envMocker.mockEnv({ HTTP_PROXY: 'http://proxy.example.com:8080' });

        assert.strictEqual(process.env.HTTP_PROXY, 'http://proxy.example.com:8080');

        envMocker.restore();

        assert.strictEqual(process.env.HTTP_PROXY, originalValue);
    });

    test('should mock multiple environment variables', () => {
        envMocker.mockEnv({
            HTTP_PROXY: 'http://proxy.example.com:8080',
            HTTPS_PROXY: 'https://proxy.example.com:8080',
            NO_PROXY: 'localhost'
        });

        assert.strictEqual(process.env.HTTP_PROXY, 'http://proxy.example.com:8080');
        assert.strictEqual(process.env.HTTPS_PROXY, 'https://proxy.example.com:8080');
        assert.strictEqual(process.env.NO_PROXY, 'localhost');
    });

    test('should restore original values on restore()', () => {
        const originalHttp = process.env.HTTP_PROXY;
        const originalHttps = process.env.HTTPS_PROXY;

        envMocker.mockEnv({
            HTTP_PROXY: 'http://test.proxy:9999',
            HTTPS_PROXY: 'https://test.proxy:9999'
        });

        envMocker.restore();

        assert.strictEqual(process.env.HTTP_PROXY, originalHttp);
        assert.strictEqual(process.env.HTTPS_PROXY, originalHttps);
    });

    test('should delete new variables on restore()', () => {
        // Use a unique env var name that doesn't exist
        const uniqueVar = 'TEST_UNIQUE_PROXY_VAR_12345';
        delete process.env[uniqueVar];

        envMocker.mockEnv({ [uniqueVar]: 'test-value' });
        assert.strictEqual(process.env[uniqueVar], 'test-value');

        envMocker.restore();
        assert.strictEqual(process.env[uniqueVar], undefined);
    });
});

suite('TestDataPatterns Test Suite', () => {
    /**
     * Task 1.2: Test data patterns verification
     * Requirements: 9.1
     */

    suite('Windows patterns', () => {
        test('should have valid ProxyEnable enabled pattern', () => {
            const pattern = TestDataPatterns.windows.proxyEnabled;
            assert.ok(pattern.includes('ProxyEnable'));
            assert.ok(pattern.includes('REG_DWORD'));
            assert.ok(pattern.includes('0x1'));
        });

        test('should have valid ProxyEnable disabled pattern', () => {
            const pattern = TestDataPatterns.windows.proxyDisabled;
            assert.ok(pattern.includes('ProxyEnable'));
            assert.ok(pattern.includes('REG_DWORD'));
            assert.ok(pattern.includes('0x0'));
        });

        test('should have valid ProxyServer http= format pattern', () => {
            const pattern = TestDataPatterns.windows.proxyServerHttpEquals;
            assert.ok(pattern.includes('ProxyServer'));
            assert.ok(pattern.includes('REG_SZ'));
            assert.ok(pattern.includes('http='));
            assert.ok(pattern.includes('proxy.example.com'));
            assert.ok(pattern.includes('8080'));
        });

        test('should have valid ProxyServer simple format pattern', () => {
            const pattern = TestDataPatterns.windows.proxyServerSimple;
            assert.ok(pattern.includes('ProxyServer'));
            assert.ok(pattern.includes('proxy.example.com:8080'));
        });
    });

    suite('macOS patterns', () => {
        test('should have valid proxy enabled pattern', () => {
            const pattern = TestDataPatterns.macos.proxyEnabled;
            assert.ok(pattern.includes('Enabled: Yes'));
            assert.ok(pattern.includes('Server: proxy.example.com'));
            assert.ok(pattern.includes('Port: 8080'));
        });

        test('should have valid proxy disabled pattern', () => {
            const pattern = TestDataPatterns.macos.proxyDisabled;
            assert.ok(pattern.includes('Enabled: No'));
        });
    });

    suite('Linux patterns', () => {
        test('should have valid manual mode pattern', () => {
            assert.strictEqual(TestDataPatterns.linux.modeManual, `'manual'`);
        });

        test('should have valid host pattern', () => {
            assert.strictEqual(TestDataPatterns.linux.host, `'proxy.example.com'`);
        });

        test('should have valid port pattern', () => {
            assert.strictEqual(TestDataPatterns.linux.port, '8080');
        });
    });

    suite('Expected proxy URL', () => {
        test('should match example.com pattern', () => {
            assert.strictEqual(
                TestDataPatterns.expectedProxyUrl,
                'http://proxy.example.com:8080'
            );
        });
    });
});

suite('ErrorPatterns Test Suite', () => {
    /**
     * Task 1.2: Error patterns verification
     * Requirements: 9.2
     */

    test('should have ENOENT error pattern', () => {
        assert.strictEqual(ErrorPatterns.enoent.code, 'ENOENT');
        assert.ok(ErrorPatterns.enoent.message.includes('ENOENT'));
    });

    test('should have EACCES error pattern', () => {
        assert.strictEqual(ErrorPatterns.eacces.code, 'EACCES');
        assert.ok(ErrorPatterns.eacces.message.includes('Permission'));
    });

    test('should have timeout error pattern', () => {
        assert.strictEqual(ErrorPatterns.timeout.killed, true);
        assert.strictEqual(ErrorPatterns.timeout.signal, 'SIGTERM');
    });
});

suite('CommandMocker Test Suite', () => {
    /**
     * Task 1.2: CommandMocker helper methods
     * Requirements: 9.1, 9.2
     */

    suite('createError', () => {
        test('should create ENOENT error with correct properties', () => {
            const error = CommandMocker.createError(ErrorPatterns.enoent);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.code, 'ENOENT');
            assert.strictEqual(errorAny.killed, false);
        });

        test('should create EACCES error with correct properties', () => {
            const error = CommandMocker.createError(ErrorPatterns.eacces);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.code, 'EACCES');
        });

        test('should create timeout error with correct properties', () => {
            const error = CommandMocker.createError(ErrorPatterns.timeout);
            const errorAny = error as any;

            assert.ok(error instanceof Error);
            assert.strictEqual(errorAny.killed, true);
            assert.strictEqual(errorAny.signal, 'SIGTERM');
        });
    });

    suite('createResponse', () => {
        test('should create response with stdout only', () => {
            const response = CommandMocker.createResponse('test output');

            assert.strictEqual(response.stdout, 'test output');
            assert.strictEqual(response.stderr, '');
        });

        test('should create response with stdout and stderr', () => {
            const response = CommandMocker.createResponse('output', 'error');

            assert.strictEqual(response.stdout, 'output');
            assert.strictEqual(response.stderr, 'error');
        });
    });

    suite('getWindowsRegistryMocks', () => {
        test('should return enabled scenario mocks', () => {
            const mocks = CommandMocker.getWindowsRegistryMocks('enabled');

            assert.strictEqual(mocks.length, 2);
            assert.ok(mocks[0].response.stdout?.includes('0x1'));
            assert.ok(mocks[1].response.stdout?.includes('ProxyServer'));
        });

        test('should return disabled scenario mocks', () => {
            const mocks = CommandMocker.getWindowsRegistryMocks('disabled');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.stdout?.includes('0x0'));
        });

        test('should return notFound scenario mocks', () => {
            const mocks = CommandMocker.getWindowsRegistryMocks('notFound');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.error);
            assert.strictEqual(mocks[0].response.error?.code, 'ENOENT');
        });
    });

    suite('getMacOSMocks', () => {
        test('should return enabled scenario mocks', () => {
            const mocks = CommandMocker.getMacOSMocks('enabled');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.stdout?.includes('Enabled: Yes'));
        });

        test('should return disabled scenario mocks', () => {
            const mocks = CommandMocker.getMacOSMocks('disabled');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.stdout?.includes('Enabled: No'));
        });

        test('should return notFound scenario mocks', () => {
            const mocks = CommandMocker.getMacOSMocks('notFound');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.error);
        });
    });

    suite('getLinuxMocks', () => {
        test('should return manual scenario mocks', () => {
            const mocks = CommandMocker.getLinuxMocks('manual');

            assert.strictEqual(mocks.length, 3);
            assert.ok(mocks[0].response.stdout?.includes('manual'));
        });

        test('should return auto scenario mocks', () => {
            const mocks = CommandMocker.getLinuxMocks('auto');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.stdout?.includes('auto'));
        });

        test('should return notFound scenario mocks', () => {
            const mocks = CommandMocker.getLinuxMocks('notFound');

            assert.strictEqual(mocks.length, 1);
            assert.ok(mocks[0].response.error);
        });
    });
});

suite('createTestSandbox Test Suite', () => {
    test('should create a valid Sinon sandbox', () => {
        const sandbox = createTestSandbox();

        assert.ok(sandbox);
        assert.ok(typeof sandbox.stub === 'function');
        assert.ok(typeof sandbox.restore === 'function');

        sandbox.restore();
    });
});
