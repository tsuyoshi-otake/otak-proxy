import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * CLI-level tests for scripts/check-invisible-unicode.mjs: NUL bytes must not
 * exempt a file from scanning, a run that scans zero files must fail, and
 * `--dir` must scan an arbitrary directory (the unzipped VSIX case) with
 * labels relative to it.
 *
 * Invisible characters are built with String.fromCodePoint so this file stays
 * clean for the scanner it exercises (see InvisibleUnicode.test.ts).
 */
suite('Invisible Unicode scanner CLI', () => {
    const SCRIPT = path.resolve(__dirname, '../../..', 'scripts/check-invisible-unicode.mjs');

    let workDir: string;

    suiteSetup(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-iuc-scan-'));
    });

    suiteTeardown(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    function runScanner(args: string[]) {
        return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    }

    function makeDir(name: string): string {
        const dir = path.join(workDir, name);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    test('a NUL byte does not skip a .js file; U+3164 in the same file is still found', () => {
        const dir = makeDir('nul-file');
        const payload = Buffer.concat([
            Buffer.from('const a = 1;\n', 'utf8'),
            Buffer.from([0x00]),
            Buffer.from(`const b = "${String.fromCodePoint(0x3164)}";\n`, 'utf8')
        ]);
        fs.writeFileSync(path.join(dir, 'payload.js'), payload);

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('U+0000'), `expected a NUL finding:\n${result.stderr}`);
        assert.ok(result.stderr.includes('U+3164'), `expected a U+3164 finding:\n${result.stderr}`);
    });

    test('flags U+2800 Braille pattern blank', () => {
        const dir = makeDir('braille');
        fs.writeFileSync(path.join(dir, 'x.js'), `a${String.fromCodePoint(0x2800)}b\n`);

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('U+2800'), result.stderr);
    });

    test('--dir on an empty directory fails instead of scanning nothing', () => {
        const dir = makeDir('empty');
        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('No files were scanned'), result.stderr);
    });

    test('an explicit empty directory fails the same way', () => {
        const dir = makeDir('explicit-empty');
        const result = runScanner([path.relative(path.resolve(__dirname, '../../..'), dir)]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('No files were scanned'), result.stderr);
    });

    test('--dir flags a payload that only exists inside the scanned tree', () => {
        const dir = makeDir('vsix-like');
        fs.mkdirSync(path.join(dir, 'extension', 'out'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'extension', 'package.json'), '{"name":"x"}\n');
        fs.writeFileSync(
            path.join(dir, 'extension', 'out', 'extension.js'),
            `clean();${String.fromCodePoint(0xe0041)}\n`
        );

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        // Findings are labeled relative to the scanned directory.
        assert.ok(
            result.stderr.includes(path.join('extension', 'out', 'extension.js').split(path.sep).join('/')),
            `expected a dir-relative label:\n${result.stderr}`
        );
        assert.ok(result.stderr.includes('U+E0041'), result.stderr);
    });

    test('--dir on a missing or non-directory path exits 2 with usage, not a stack trace', () => {
        const missing = runScanner(['--dir', path.join(workDir, 'does-not-exist')]);
        assert.strictEqual(missing.status, 2, missing.stderr + missing.stdout);
        assert.ok(missing.stderr.includes('does not exist'), missing.stderr);
        assert.ok(missing.stderr.includes('Usage:'), missing.stderr);
        assert.ok(!/^\s*at\s/m.test(missing.stderr), missing.stderr);

        const filePath = path.join(workDir, 'a-file.txt');
        fs.writeFileSync(filePath, 'plain text\n');
        const notDir = runScanner(['--dir', filePath]);
        assert.strictEqual(notDir.status, 2, notDir.stderr + notDir.stdout);
        assert.ok(notDir.stderr.includes('not a directory'), notDir.stderr);
        assert.ok(!/^\s*at\s/m.test(notDir.stderr), notDir.stderr);
    });

    test('--dir combined with --dist exits 2 with usage', () => {
        const result = runScanner(['--dir', workDir, '--dist']);
        assert.strictEqual(result.status, 2, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('cannot be combined'), result.stderr);
    });

    test('--dir combined with an explicit path exits 2 with usage', () => {
        const result = runScanner(['--dir', workDir, 'README.md']);
        assert.strictEqual(result.status, 2, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('cannot be combined'), result.stderr);
    });
});
