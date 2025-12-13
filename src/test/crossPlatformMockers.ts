/**
 * Cross-Platform Mocking Utilities
 * Provides PlatformMocker and test data helpers for cross-platform testing
 *
 * Feature: cross-platform-support
 * Requirements: 9.1, 9.2, 9.4
 */

import * as sinon from 'sinon';

/**
 * Response structure for exec/execFile mocks
 */
export interface ExecMockResponse {
    stdout?: string;
    stderr?: string;
    error?: {
        code?: string | number;
        message?: string;
        killed?: boolean;
        signal?: string;
    };
}

/**
 * Command mock configuration
 */
export interface CommandMockConfig {
    command: string | RegExp;
    response: ExecMockResponse;
}

/**
 * PlatformMocker - Safely mocks process.platform property
 * Uses Object.defineProperty for property override
 *
 * Requirements: 9.4
 */
export class PlatformMocker {
    /**
     * Mocks process.platform to specified value
     * @param platform - Target platform: 'win32' | 'darwin' | 'linux'
     * @returns Restore function to revert to original value
     */
    static mockPlatform(platform: NodeJS.Platform): () => void {
        const originalPlatform = process.platform;

        Object.defineProperty(process, 'platform', {
            value: platform,
            writable: true,
            configurable: true
        });

        return () => {
            Object.defineProperty(process, 'platform', {
                value: originalPlatform,
                writable: false,
                configurable: true
            });
        };
    }
}

/**
 * Test data patterns for cross-platform proxy detection
 * Uses example.com domain as per design.md security requirements
 */
export const TestDataPatterns = {
    /**
     * Windows registry output patterns
     */
    windows: {
        proxyEnabled: `
    ProxyEnable    REG_DWORD    0x1
`,
        proxyDisabled: `
    ProxyEnable    REG_DWORD    0x0
`,
        proxyServerHttpEquals: `
    ProxyServer    REG_SZ    http=proxy.example.com:8080;https=proxy.example.com:8080
`,
        proxyServerSimple: `
    ProxyServer    REG_SZ    proxy.example.com:8080
`,
        proxyServerWithProtocol: `
    ProxyServer    REG_SZ    http://proxy.example.com:8080
`,
        notFound: '', // Empty output when registry key not found
    },

    /**
     * macOS networksetup output patterns
     */
    macos: {
        proxyEnabled: `Enabled: Yes
Server: proxy.example.com
Port: 8080
Authenticated Proxy Enabled: 0
`,
        proxyDisabled: `Enabled: No
Server:
Port: 0
Authenticated Proxy Enabled: 0
`,
        interfaceNotFound: `** Error: The parameters were not valid.
`,
    },

    /**
     * Linux gsettings output patterns
     */
    linux: {
        modeManual: `'manual'`,
        modeAuto: `'auto'`,
        modeNone: `'none'`,
        host: `'proxy.example.com'`,
        port: `8080`,
        hostEmpty: `''`,
        portZero: `0`,
    },

    /**
     * Expected proxy URL from test data
     */
    expectedProxyUrl: 'http://proxy.example.com:8080',
};

/**
 * Error simulation patterns for testing
 */
export const ErrorPatterns = {
    enoent: {
        code: 'ENOENT',
        message: 'spawn ENOENT',
    },
    eacces: {
        code: 'EACCES',
        message: 'Permission denied',
    },
    timeout: {
        message: 'Command timed out',
        killed: true,
        signal: 'SIGTERM',
    },
};

/**
 * CommandMocker - Creates mock responses for command testing
 * Since child_process cannot be directly stubbed, this provides
 * helper methods for creating test scenarios
 *
 * Requirements: 9.1, 9.2
 */
export class CommandMocker {
    /**
     * Creates a mock error object matching child_process error format
     */
    static createError(pattern: typeof ErrorPatterns.enoent | typeof ErrorPatterns.eacces | typeof ErrorPatterns.timeout): Error {
        const error = new Error(pattern.message);
        (error as any).code = (pattern as any).code;
        (error as any).killed = (pattern as any).killed || false;
        (error as any).signal = (pattern as any).signal;
        return error;
    }

    /**
     * Creates a mock stdout response
     */
    static createResponse(stdout: string, stderr: string = ''): { stdout: string; stderr: string } {
        return { stdout, stderr };
    }

    /**
     * Gets Windows registry mock responses for a specific scenario
     */
    static getWindowsRegistryMocks(scenario: 'enabled' | 'disabled' | 'notFound'): CommandMockConfig[] {
        switch (scenario) {
            case 'enabled':
                return [
                    {
                        command: /ProxyEnable/,
                        response: { stdout: TestDataPatterns.windows.proxyEnabled }
                    },
                    {
                        command: /ProxyServer/,
                        response: { stdout: TestDataPatterns.windows.proxyServerHttpEquals }
                    }
                ];
            case 'disabled':
                return [
                    {
                        command: /ProxyEnable/,
                        response: { stdout: TestDataPatterns.windows.proxyDisabled }
                    }
                ];
            case 'notFound':
                return [
                    {
                        command: /ProxyEnable/,
                        response: { error: ErrorPatterns.enoent }
                    }
                ];
        }
    }

    /**
     * Gets macOS networksetup mock responses for a specific scenario
     */
    static getMacOSMocks(scenario: 'enabled' | 'disabled' | 'notFound'): CommandMockConfig[] {
        switch (scenario) {
            case 'enabled':
                return [
                    {
                        command: /networksetup.*Wi-Fi/,
                        response: { stdout: TestDataPatterns.macos.proxyEnabled }
                    }
                ];
            case 'disabled':
                return [
                    {
                        command: /networksetup.*Wi-Fi/,
                        response: { stdout: TestDataPatterns.macos.proxyDisabled }
                    }
                ];
            case 'notFound':
                return [
                    {
                        command: /networksetup/,
                        response: { error: ErrorPatterns.enoent }
                    }
                ];
        }
    }

    /**
     * Gets Linux gsettings mock responses for a specific scenario
     */
    static getLinuxMocks(scenario: 'manual' | 'auto' | 'none' | 'notFound'): CommandMockConfig[] {
        switch (scenario) {
            case 'manual':
                return [
                    {
                        command: /gsettings.*mode/,
                        response: { stdout: TestDataPatterns.linux.modeManual }
                    },
                    {
                        command: /gsettings.*host/,
                        response: { stdout: TestDataPatterns.linux.host }
                    },
                    {
                        command: /gsettings.*port/,
                        response: { stdout: TestDataPatterns.linux.port.toString() }
                    }
                ];
            case 'auto':
                return [
                    {
                        command: /gsettings.*mode/,
                        response: { stdout: TestDataPatterns.linux.modeAuto }
                    }
                ];
            case 'none':
                return [
                    {
                        command: /gsettings.*mode/,
                        response: { stdout: TestDataPatterns.linux.modeNone }
                    }
                ];
            case 'notFound':
                return [
                    {
                        command: /gsettings/,
                        response: { error: ErrorPatterns.enoent }
                    }
                ];
        }
    }
}

/**
 * Test helper for creating Sinon sandbox with common setup
 */
export function createTestSandbox(): sinon.SinonSandbox {
    return sinon.createSandbox();
}

/**
 * Environment variable mocker for testing env-based proxy detection
 */
export class EnvMocker {
    private originalEnv: Record<string, string | undefined> = {};
    private mockedVars: string[] = [];

    /**
     * Sets environment variables for testing
     */
    mockEnv(vars: Record<string, string>): void {
        for (const [key, value] of Object.entries(vars)) {
            this.originalEnv[key] = process.env[key];
            process.env[key] = value;
            this.mockedVars.push(key);
        }
    }

    /**
     * Restores original environment variables
     */
    restore(): void {
        for (const key of this.mockedVars) {
            if (this.originalEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = this.originalEnv[key];
            }
        }
        this.mockedVars = [];
        this.originalEnv = {};
    }
}
