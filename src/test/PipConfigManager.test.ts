import * as assert from 'assert';
import {
    classifyPipConfigError,
    PipCommandRunner,
    PipConfigManager
} from '../config/PipConfigManager';

type CommandCall = {
    command: string;
    args: string[];
};

function commandError(message: string, options: {
    code?: string | number;
    stderr?: string;
    killed?: boolean;
    signal?: string;
} = {}): Error & {
    code?: string | number;
    stderr?: string;
    killed?: boolean;
    signal?: string;
} {
    const error = new Error(message) as Error & {
        code?: string | number;
        stderr?: string;
        killed?: boolean;
        signal?: string;
    };
    error.code = options.code;
    error.stderr = options.stderr;
    error.killed = options.killed;
    error.signal = options.signal;
    return error;
}

function noSuchKeyError(): Error & { code?: string | number; stderr?: string } {
    return commandError('Command failed: python -m pip config --user get global.proxy', {
        code: 1,
        stderr: 'ERROR: No such key - global.proxy'
    });
}

suite('PipConfigManager Test Suite', () => {
    test('setProxy should write global.proxy through python -m pip config --user', async () => {
        const calls: CommandCall[] = [];
        const runner: PipCommandRunner = async (command, args) => {
            calls.push({ command, args });
            return { stdout: 'Writing to user config\n', stderr: '' };
        };
        const manager = new PipConfigManager({
            commandRunner: runner,
            candidates: [{ command: 'python3', argsPrefix: ['-m', 'pip'] }]
        });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.deepStrictEqual(result, { success: true });
        assert.deepStrictEqual(calls, [{
            command: 'python3',
            args: ['-m', 'pip', 'config', '--user', 'set', 'global.proxy', 'http://proxy.example.com:8080']
        }]);
    });

    test('getProxy should return null when global.proxy is not configured', async () => {
        const manager = new PipConfigManager({
            commandRunner: async () => {
                throw noSuchKeyError();
            },
            candidates: [{ command: 'python3', argsPrefix: ['-m', 'pip'] }]
        });

        const result = await manager.getProxy();

        assert.strictEqual(result, null);
    });

    test('unsetProxy should be idempotent when global.proxy is not configured', async () => {
        const calls: CommandCall[] = [];
        const manager = new PipConfigManager({
            commandRunner: async (command, args) => {
                calls.push({ command, args });
                throw noSuchKeyError();
            },
            candidates: [{ command: 'python3', argsPrefix: ['-m', 'pip'] }]
        });

        const result = await manager.unsetProxy();

        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].args, ['-m', 'pip', 'config', '--user', 'get', 'global.proxy']);
    });

    test('should round-trip set, get, and unset with the injected runner', async () => {
        let configuredProxy: string | undefined;
        const calls: CommandCall[] = [];
        const runner: PipCommandRunner = async (command, args) => {
            calls.push({ command, args });
            const action = args[4];
            if (action === 'set') {
                configuredProxy = args[6];
                return { stdout: 'Writing to user config\n', stderr: '' };
            }
            if (action === 'get') {
                if (!configuredProxy) {
                    throw noSuchKeyError();
                }
                return { stdout: `${configuredProxy}\n`, stderr: '' };
            }
            if (action === 'unset') {
                configuredProxy = undefined;
                return { stdout: 'Writing to user config\n', stderr: '' };
            }
            throw new Error(`Unexpected args: ${args.join(' ')}`);
        };
        const manager = new PipConfigManager({
            commandRunner: runner,
            candidates: [{ command: 'python3', argsPrefix: ['-m', 'pip'] }]
        });

        assert.deepStrictEqual(await manager.setProxy('http://proxy.example.com:8080'), { success: true });
        assert.strictEqual(await manager.getProxy(), 'http://proxy.example.com:8080');
        assert.deepStrictEqual(await manager.unsetProxy(), { success: true });
        assert.strictEqual(await manager.getProxy(), null);
        assert.ok(calls.some(call => call.args.includes('unset')));
    });

    test('should try the next Python candidate when the first command is missing', async () => {
        const calls: CommandCall[] = [];
        const runner: PipCommandRunner = async (command, args) => {
            calls.push({ command, args });
            if (command === 'python3') {
                throw commandError('spawn python3 ENOENT', { code: 'ENOENT' });
            }
            return { stdout: 'Writing to user config\n', stderr: '' };
        };
        const manager = new PipConfigManager({
            commandRunner: runner,
            candidates: [
                { command: 'python3', argsPrefix: ['-m', 'pip'] },
                { command: 'python', argsPrefix: ['-m', 'pip'] }
            ]
        });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.deepStrictEqual(result, { success: true });
        assert.deepStrictEqual(calls.map(call => call.command), ['python3', 'python']);
    });

    test('should return NOT_INSTALLED when Python or pip cannot be resolved', async () => {
        const calls: CommandCall[] = [];
        const runner: PipCommandRunner = async (command, args) => {
            calls.push({ command, args });
            throw commandError('No module named pip', {
                code: 1,
                stderr: 'C:\\Python\\python.exe: No module named pip'
            });
        };
        const manager = new PipConfigManager({
            commandRunner: runner,
            candidates: [
                { command: 'python3', argsPrefix: ['-m', 'pip'] },
                { command: 'python', argsPrefix: ['-m', 'pip'] }
            ]
        });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'NOT_INSTALLED');
        assert.strictEqual(result.error, 'pip is not installed or Python is not in PATH');
        assert.strictEqual(calls.length, 2);
    });

    test('should keep real pip configuration failures as errors', async () => {
        const manager = new PipConfigManager({
            commandRunner: async () => {
                throw commandError('Command failed: python -m pip config --user set global.proxy http://proxy.example.com:8080', {
                    code: 2,
                    stderr: 'ERROR: Failed to write pip config'
                });
            },
            candidates: [{ command: 'python3', argsPrefix: ['-m', 'pip'] }]
        });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'CONFIG_ERROR');
        assert.strictEqual(result.error, 'Failed to read/write pip configuration');
    });

    test('should classify Windows missing Python launcher output as NOT_INSTALLED', () => {
        const result = classifyPipConfigError(commandError(
            'Command failed: py -m pip config --user set global.proxy http://proxy.example.com:8080',
            {
                code: 9009,
                stderr: 'Python was not found; run without arguments to install from the Microsoft Store.'
            }
        ), 5000);

        assert.strictEqual(result.errorType, 'NOT_INSTALLED');
        assert.strictEqual(result.error, 'pip is not installed or Python is not in PATH');
    });

    test('should classify pip timeouts', () => {
        const result = classifyPipConfigError(commandError('Command timed out', {
            killed: true,
            signal: 'SIGTERM'
        }), 5000);

        assert.strictEqual(result.errorType, 'TIMEOUT');
        assert.strictEqual(result.error, 'pip command timed out after 5000ms');
    });
});
