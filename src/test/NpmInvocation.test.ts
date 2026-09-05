import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveNpmInvocation } from '../utils/NpmInvocation';

suite('NpmInvocation', () => {
    test('unix invocation is execFile(npm, args) without a shell', () => {
        const invocation = resolveNpmInvocation(['config', 'get', 'proxy'], {
            isWindows: false,
            env: { PATH: '/usr/bin' }
        });
        assert.deepStrictEqual(invocation, { command: 'npm', args: ['config', 'get', 'proxy'] });
    });

    test('Windows invocation is node + npm-cli.js, not cmd.exe', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-npm-inv-'));
        try {
            fs.mkdirSync(path.join(root, 'node_modules', 'npm', 'bin'), { recursive: true });
            fs.writeFileSync(path.join(root, 'npm.cmd'), '');
            const cliJs = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
            fs.writeFileSync(cliJs, '');
            const url = 'http://user:x%25OS%25y@proxy.example:8080';
            const invocation = resolveNpmInvocation(['config', 'set', 'proxy', url], {
                isWindows: true,
                env: {
                    PATH: `${root};${process.env.PATH || ''}`,
                    PATHEXT: '.COM;.EXE;.BAT;.CMD'
                }
            });

            const commandBase = path.basename(invocation.command).toLowerCase();
            assert.ok(commandBase === 'node.exe' || commandBase === 'node');
            assert.strictEqual(invocation.args[0], cliJs);
            assert.ok(invocation.args.includes(url));
            assert.ok(!invocation.args.includes('/c'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
