import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

/**
 * Tests for scripts/release/check-release-ref.mjs - the gate that keeps a tag
 * push from publishing the wrong commit. The ref-name and version checks are
 * pure; the ancestry check runs once against a real temporary `git init`
 * repository (the unit runner already isolates GIT_CONFIG_GLOBAL).
 */

interface ReleaseRefModule {
    ReleaseRefError: new (message: string) => Error;
    versionFromTagRef: (ref: string, refType?: string) => string;
    checkTagMatchesVersion: (ref: string, packageVersion: string, refType?: string) => string;
    checkTagOnMain: (exec: (args: string[]) => void, commit: string, branchRef?: string) => void;
    run: (options?: {
        env?: { [key: string]: string | undefined };
        mainRef?: string;
        exec?: (args: string[]) => void;
        packageVersion?: string;
    }) => number;
}

let mod: ReleaseRefModule;

suite('check-release-ref', () => {
    suiteSetup(async () => {
        const moduleSpecifier = pathToFileURL(
            path.resolve(__dirname, '../..', 'scripts/release/check-release-ref.mjs')
        ).href;
        mod = await import(moduleSpecifier);
    });

    test('accepts a tag ref whose version matches package.json', () => {
        assert.strictEqual(
            mod.checkTagMatchesVersion('refs/tags/v3.2.16', '3.2.16', 'tag'),
            '3.2.16'
        );
    });

    test('a full run() passes for a tag on the ancestry-checked ref', () => {
        const execCalls: string[][] = [];
        const status = mod.run({
            env: {
                GITHUB_REF: 'refs/tags/v3.2.16',
                GITHUB_SHA: 'a'.repeat(40),
                GITHUB_REF_TYPE: 'tag'
            },
            packageVersion: '3.2.16',
            exec: (args) => { execCalls.push(args); }
        });
        assert.strictEqual(status, 0);
        assert.deepStrictEqual(execCalls, [['merge-base', '--is-ancestor', 'a'.repeat(40), 'origin/main']]);
    });

    test('a branch named like a tag is not a release ref', () => {
        // The trap the old GITHUB_REF_NAME check fell for: refs/heads/v3.2.16
        // has the same bare name as the tag.
        assert.throws(
            () => mod.checkTagMatchesVersion('refs/heads/v3.2.16', '3.2.16'),
            /not a refs\/tags/);
        assert.throws(
            () => mod.run({
                env: { GITHUB_REF: 'refs/heads/v3.2.16', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF_TYPE: 'branch' },
                packageVersion: '3.2.16',
                exec: () => { assert.fail('exec must not run when the ref is not a tag'); }
            }),
            /GITHUB_REF_TYPE is branch/);
    });

    test('missing GITHUB_REF fails', () => {
        assert.throws(() => mod.checkTagMatchesVersion('', '3.2.16'), /Missing GITHUB_REF/);
        assert.throws(
            () => mod.run({
                env: { GITHUB_SHA: 'a'.repeat(40) },
                packageVersion: '3.2.16',
                exec: () => { assert.fail('exec must not run without a ref'); }
            }),
            /Missing GITHUB_REF/);
    });

    test('rejects a tag/version mismatch', () => {
        assert.throws(
            () => mod.checkTagMatchesVersion('refs/tags/v3.2.17', '3.2.16', 'tag'),
            /does not match/);
    });

    test('rejects other non-tag refs', () => {
        assert.throws(() => mod.checkTagMatchesVersion('refs/heads/main', '3.2.16'), /not a refs\/tags/);
        assert.throws(() => mod.checkTagMatchesVersion('v3.2.16', '3.2.16'), /not a refs\/tags/);
        assert.throws(() => mod.checkTagMatchesVersion('refs/pull/1/merge', '3.2.16'), /not a refs\/tags/);
    });

    test('rejects a non-semver tag', () => {
        assert.throws(() => mod.checkTagMatchesVersion('refs/tags/vlatest', '3.2.16'), /not a refs\/tags/);
    });

    suite('real git repository', () => {
        let repoDir: string;
        let mainCommit: string;
        let sideCommit: string;

        const git = (args: string[]) =>
            execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' }).toString().trim();

        suiteSetup(() => {
            repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-release-ref-'));
            git(['init', '-b', 'main']);
            fs.writeFileSync(path.join(repoDir, 'f.txt'), 'one\n');
            git(['add', 'f.txt']);
            git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'one']);
            mainCommit = git(['rev-parse', 'HEAD']);

            // A commit that is not reachable from main.
            git(['checkout', '-b', 'side']);
            fs.writeFileSync(path.join(repoDir, 'f.txt'), 'two\n');
            git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-am', 'two']);
            sideCommit = git(['rev-parse', 'HEAD']);
            git(['checkout', 'main']);
        });

        suiteTeardown(() => {
            fs.rmSync(repoDir, { recursive: true, force: true });
        });

        test('a commit on main passes the ancestry check', () => {
            assert.doesNotThrow(() =>
                mod.checkTagOnMain((args) => { git(args); }, mainCommit, 'main'));
        });

        test('a commit off main fails the ancestry check', () => {
            assert.throws(
                () => mod.checkTagOnMain((args) => { git(args); }, sideCommit, 'main'),
                /not reachable from main/);
        });

        test('a malformed commit SHA fails before git runs', () => {
            let ran = false;
            assert.throws(
                () => mod.checkTagOnMain(() => { ran = true; }, 'not-a-sha', 'main'),
                /malformed commit SHA/);
            assert.strictEqual(ran, false);
        });
    });
});
