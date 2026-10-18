import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ensureLockDir,
    ensurePerUserLockDir,
    LockDirDeps,
    perUserLockDirPath
} from '../../utils/PerUserLockDir';

/**
 * #108 item 4: on a shared POSIX temp directory the first user's umask decided
 * who could enter the shared `otak-proxy` lock directory, so a second user's
 * applies and Git writes failed with EACCES. POSIX locks now live under a
 * per-user `<tmpdir>/otak-proxy-<uid>` created 0700 and checked before use;
 * Windows keeps its historical (already per-user) paths.
 */
suite('PerUserLockDir (#108)', function() {
    let workDir: string;

    setup(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-lockdir-'));
    });

    teardown(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    function deps(overrides: Partial<LockDirDeps> = {}): LockDirDeps {
        return { tmpdir: () => workDir, ...overrides };
    }

    function fakeStats(stat: { directory: boolean; uid?: number; mode?: number }): fs.Stats {
        return {
            isDirectory: () => stat.directory,
            uid: stat.uid ?? 0,
            mode: stat.mode ?? 0
        } as fs.Stats;
    }

    function errnoError(code: string): NodeJS.ErrnoException {
        return Object.assign(new Error(`injected ${code}`), { code });
    }

    /**
     * Defines `process.getuid` for the scope of `run`, restoring the previous
     * own property (or its absence) afterwards. Windows has no `getuid`, so
     * rows that exercise the default uid source must install one (#108).
     */
    function withTemporaryGetuid(uid: number, run: () => void): void {
        const previous = Object.getOwnPropertyDescriptor(process, 'getuid');
        Object.defineProperty(process, 'getuid', {
            configurable: true,
            writable: true,
            value: () => uid
        });
        try {
            run();
        } finally {
            if (previous) {
                Object.defineProperty(process, 'getuid', previous);
            } else {
                delete (process as { getuid?: unknown }).getuid;
            }
        }
    }

    suite('perUserLockDirPath', () => {
        test('linux with uid 1000 gives <tmpdir>/otak-proxy-1000', () => {
            assert.strictEqual(
                perUserLockDirPath(deps({ platform: 'linux', getuid: () => 1000 })),
                path.join(workDir, 'otak-proxy-1000')
            );
        });

        test('win32 keeps the temp directory itself', () => {
            assert.strictEqual(perUserLockDirPath(deps({ platform: 'win32' })), workDir);
        });

        test('a non-Windows platform without getuid falls back to the temp path', () => {
            // The path still computes so GIT_CONFIG_MUTEX_PATH resolves, but
            // ensurePerUserLockDir reports it unusable rather than silently shared.
            assert.strictEqual(
                perUserLockDirPath(deps({ platform: 'linux', getuid: null })),
                workDir
            );
        });

        test('linux without a getuid key, or with getuid: undefined, uses process.getuid', () => {
            withTemporaryGetuid(4242, () => {
                assert.strictEqual(
                    perUserLockDirPath(deps({ platform: 'linux' })),
                    path.join(workDir, 'otak-proxy-4242')
                );
                assert.strictEqual(
                    perUserLockDirPath(deps({ platform: 'linux', getuid: undefined })),
                    path.join(workDir, 'otak-proxy-4242')
                );
            });
        });
    });

    suite('ensurePerUserLockDir', () => {
        test('win32 is always usable', () => {
            const status = ensurePerUserLockDir(deps({ platform: 'win32' }));
            assert.deepStrictEqual(status, { usable: true, dir: workDir });
        });

        test('a missing getuid reports noUid (fail closed)', () => {
            const status = ensurePerUserLockDir(deps({ platform: 'linux', getuid: null }));
            assert.deepStrictEqual(status, { usable: false, dir: workDir, why: 'noUid' });
        });

        test('no getuid key, or getuid: undefined, resolves the uid through process.getuid', () => {
            const fileSystem = {
                mkdirSync: () => undefined,
                lstatSync: () => fakeStats({ directory: true, uid: 4242, mode: 0o40700 })
            } as unknown as LockDirDeps['fileSystem'];
            withTemporaryGetuid(4242, () => {
                assert.deepStrictEqual(
                    ensurePerUserLockDir(deps({ platform: 'linux', fileSystem })),
                    { usable: true, dir: path.join(workDir, 'otak-proxy-4242') }
                );
                assert.deepStrictEqual(
                    ensurePerUserLockDir(deps({ platform: 'linux', getuid: undefined, fileSystem })),
                    { usable: true, dir: path.join(workDir, 'otak-proxy-4242') }
                );
            });
        });

        test('a throwing getuid reports noUid', () => {
            const status = ensurePerUserLockDir(deps({
                platform: 'linux',
                getuid: () => { throw new Error('no passwd entry'); }
            }));
            assert.deepStrictEqual(status, { usable: false, dir: workDir, why: 'noUid' });
        });

        test('creates the per-user directory and accepts it', function() {
            if (process.platform === 'win32') {
                // The owner check compares stat.uid, which Windows does not
                // provide meaningfully; the POSIX-real rows run on POSIX CI.
                this.skip();
            }
            const status = ensurePerUserLockDir(deps({ platform: 'linux', getuid: () => process.getuid!() }));
            assert.deepStrictEqual(status, {
                usable: true,
                dir: path.join(workDir, `otak-proxy-${process.getuid!()}`)
            });
            const stat = fs.statSync(path.join(workDir, `otak-proxy-${process.getuid!()}`));
            assert.strictEqual(stat.mode & 0o777, 0o700, 'the per-user directory must be 0700');
        });

        test('a symlink at the path is rejected as notDirectory', function() {
            if (process.platform === 'win32') {
                this.skip();
            }
            const dir = path.join(workDir, 'otak-proxy-1000');
            fs.mkdirSync(path.join(workDir, 'real-target'));
            fs.symlinkSync(path.join(workDir, 'real-target'), dir);
            const status = ensurePerUserLockDir(deps({ platform: 'linux', getuid: () => 1000 }));
            assert.deepStrictEqual(status, { usable: false, dir, why: 'notDirectory' });
        });

        test('a real 0777 directory is rejected as insecureMode', function() {
            if (process.platform === 'win32') {
                this.skip();
            }
            // The owner check compares stat.uid against the real uid, so the
            // directory must carry this user's name (CI runners are not uid 1000).
            const uid = process.getuid!();
            const dir = path.join(workDir, `otak-proxy-${uid}`);
            fs.mkdirSync(dir, { mode: 0o777 });
            fs.chmodSync(dir, 0o777);
            const status = ensurePerUserLockDir(deps({ platform: 'linux', getuid: () => uid }));
            assert.deepStrictEqual(status, { usable: false, dir, why: 'insecureMode' });
        });
    });

    suite('ensureLockDir checks (stubbed lstat)', () => {
        // Wrong owner needs root to create for real, and Windows reports no
        // meaningful uid/mode, so these rows drive the checks through an
        // injected filesystem.
        test('a directory owned by another uid is rejected as wrongOwner', () => {
            const fileSystem = {
                mkdirSync: () => undefined,
                lstatSync: () => fakeStats({ directory: true, uid: 2000, mode: 0o40700 })
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: false, dir: '/locks', why: 'wrongOwner' });
        });

        test('a mode with group/other bits is rejected as insecureMode', () => {
            const fileSystem = {
                mkdirSync: () => undefined,
                lstatSync: () => fakeStats({ directory: true, uid: 1000, mode: 0o40755 })
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: false, dir: '/locks', why: 'insecureMode' });
        });

        test('a path that exists but is not a directory is rejected', () => {
            const filePath = path.join(workDir, 'not-a-dir');
            fs.writeFileSync(filePath, 'x');
            const status = ensureLockDir(filePath, undefined, deps());
            assert.deepStrictEqual(status, { usable: false, dir: filePath, why: 'notDirectory' });
        });

        test('EACCES from mkdir reports accessDenied', () => {
            const fileSystem = {
                mkdirSync: () => { throw errnoError('EACCES'); },
                lstatSync: fs.lstatSync
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: false, dir: '/locks', why: 'accessDenied' });
        });

        test('EPERM from lstat reports accessDenied', () => {
            const fileSystem = {
                mkdirSync: () => undefined,
                lstatSync: () => { throw errnoError('EPERM'); }
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: false, dir: '/locks', why: 'accessDenied' });
        });

        test('EEXIST from mkdir goes on to the lstat check', () => {
            const fileSystem = {
                mkdirSync: () => { throw errnoError('EEXIST'); },
                lstatSync: () => fakeStats({ directory: true, uid: 1000, mode: 0o40700 })
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: true, dir: '/locks' });
        });

        test('ENOSPC from mkdir still throws', () => {
            const fileSystem = {
                mkdirSync: () => { throw errnoError('ENOSPC'); },
                lstatSync: fs.lstatSync
            } as unknown as LockDirDeps['fileSystem'];
            assert.throws(
                () => ensureLockDir('/locks', 1000, deps({ platform: 'linux', fileSystem })),
                (error: NodeJS.ErrnoException) => error.code === 'ENOSPC'
            );
        });

        test('an override directory skips the owner and mode checks', () => {
            // OTAK_PROXY_LOCK_DIR / baseDir get the real-directory check only:
            // a 0777 directory owned by another uid is still accepted there.
            const fileSystem = {
                mkdirSync: () => undefined,
                lstatSync: () => fakeStats({ directory: true, uid: 2000, mode: 0o40777 })
            } as unknown as LockDirDeps['fileSystem'];
            const status = ensureLockDir('/locks', undefined, deps({ platform: 'linux', fileSystem }));
            assert.deepStrictEqual(status, { usable: true, dir: '/locks' });
        });
    });
});
