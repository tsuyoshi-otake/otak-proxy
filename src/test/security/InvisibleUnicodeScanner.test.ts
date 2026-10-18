import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
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

    // Extensions are never trusted: require() parses any file that is not
    // .json/.node as JavaScript, so a binary extension only skips the scan
    // when the bytes carry that format's signature.

    test('a .png/.mp3/.gif whose bytes are plain JavaScript text is still scanned', () => {
        const dir = makeDir('extension-spoof');
        fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'sounds'), { recursive: true });
        const zwsp = String.fromCodePoint(0x200b);
        fs.writeFileSync(path.join(dir, 'images', 'payload.png'), `const a = "${zwsp}";\n`);
        fs.writeFileSync(path.join(dir, 'sounds', 'payload.mp3'), `const a = "${zwsp}";\n`);
        fs.writeFileSync(path.join(dir, 'x.gif'), `GIF89a=1;${zwsp}\n`);
        // A real VSIX contains more than the payloads: one clean file, so a
        // scanner that silently skips all three still scans something and
        // cannot hide behind the zero-scan guard.
        fs.writeFileSync(path.join(dir, 'clean.js'), 'const ok = 1;\n');

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('images/payload.png'), `expected an images/payload.png finding:\n${result.stderr}`);
        assert.ok(result.stderr.includes('sounds/payload.mp3'), `expected a sounds/payload.mp3 finding:\n${result.stderr}`);
        assert.ok(result.stderr.includes('x.gif'), `expected an x.gif finding:\n${result.stderr}`);
    });

    test('files whose bytes carry the signature of their binary extension are skipped and counted', () => {
        const dir = makeDir('real-binary');
        fs.writeFileSync(path.join(dir, 'a.png'), Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from([0x00, 0x1b, 0x00])
        ]));
        fs.writeFileSync(path.join(dir, 'b.mp3'), Buffer.concat([
            Buffer.alloc(365),
            Buffer.from([0xff, 0xfb, 0x80, 0x00, 0x00, 0x02])
        ]));
        fs.writeFileSync(path.join(dir, 'c.mp3'), Buffer.from([
            0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00
        ]));
        fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n');

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 0, result.stderr + result.stdout);
        assert.ok(/3 binary/.test(result.stdout), `expected 3 binary in the summary:\n${result.stdout}`);
    });

    test('a .png whose signature bytes do not match is scanned and fails closed', () => {
        const dir = makeDir('bad-signature');
        fs.writeFileSync(path.join(dir, 'fake.png'), Buffer.from([
            0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x1b
        ]));
        fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n');

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('fake.png'), `expected a fake.png finding:\n${result.stderr}`);
    });

    test('an unreadable file fails the run even when other files scanned', function () {
        // chmod cannot deny reads on Windows, and root can read anything.
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip();
            return;
        }
        const dir = makeDir('unreadable');
        fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n');
        const locked = path.join(dir, 'locked.js');
        fs.writeFileSync(locked, 'const b = 2;\n');
        fs.chmodSync(locked, 0o000);
        try {
            const result = runScanner(['--dir', dir]);
            assert.strictEqual(result.status, 1, result.stderr + result.stdout);
            assert.ok(result.stderr.includes('locked.js'), `expected locked.js in stderr:\n${result.stderr}`);
            assert.ok(result.stderr.includes('EACCES'), `expected the error code in stderr:\n${result.stderr}`);
        } finally {
            fs.chmodSync(locked, 0o600);
        }
    });

    test('a directory entry that is not a regular file fails the run', function () {
        const dir = makeDir('non-regular');
        fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n');
        const target = path.join(dir, 'real-target.js');
        fs.writeFileSync(target, 'const c = 3;\n');
        const link = path.join(dir, 'link.js');
        try {
            fs.symlinkSync(target, link);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // Windows refuses to create a symlink without Developer Mode or
            // administrator rights; every other failure is a real error.
            if (code === 'EPERM') {
                this.skip();
                return;
            }
            throw error;
        }

        const result = runScanner(['--dir', dir]);
        assert.strictEqual(result.status, 1, result.stderr + result.stdout);
        assert.ok(result.stderr.includes('link.js'), `expected link.js in stderr:\n${result.stderr}`);
    });

    test('repository mode tolerates a tracked file that is missing from the working tree', () => {
        const repoDir = makeDir('repo-mode');
        const scriptDir = path.join(repoDir, 'scripts');
        fs.mkdirSync(path.join(scriptDir, 'lib'), { recursive: true });
        const scriptsRoot = path.resolve(__dirname, '../../..', 'scripts');
        fs.copyFileSync(SCRIPT, path.join(scriptDir, 'check-invisible-unicode.mjs'));
        for (const name of fs.readdirSync(path.join(scriptsRoot, 'lib'))) {
            if (name.endsWith('.mjs')) {
                fs.copyFileSync(
                    path.join(scriptsRoot, 'lib', name),
                    path.join(scriptDir, 'lib', name)
                );
            }
        }

        const git = (args: string[]) =>
            execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
        const commit = (message: string) =>
            git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);

        git(['init']);
        fs.writeFileSync(path.join(repoDir, 'kept.txt'), 'kept\n');
        fs.writeFileSync(path.join(repoDir, 'gone.txt'), 'gone\n');
        git(['add', '-A']);
        commit('one');
        fs.unlinkSync(path.join(repoDir, 'gone.txt'));

        const result = spawnSync(
            process.execPath,
            [path.join(scriptDir, 'check-invisible-unicode.mjs')],
            { cwd: repoDir, encoding: 'utf8' }
        );
        assert.strictEqual(result.status, 0, result.stderr + result.stdout);
        assert.ok(/1 missing/.test(result.stdout), `expected 1 missing in the summary:\n${result.stdout}`);
    });
});
