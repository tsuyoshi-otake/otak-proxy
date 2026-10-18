import * as assert from 'assert';
import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApplyLockRequest, ApplyLockService, ApplyLockServiceOptions } from '../../remediation/ApplyLockService';

type LockFileSystem = NonNullable<ApplyLockServiceOptions['fileSystem']>;

/**
 * #108 item 4: lock I/O errors are an explicit `ioError` outcome instead of an
 * exception. The POSIX default lives in a per-user `<tmpdir>/otak-proxy-<uid>`
 * created 0700; EACCES/EPERM from `mkdir`/`open` and an unusable directory all
 * acquire no lock and report ioError, while other errno values still throw.
 */
suite('ApplyLockService lock directory ioError (#108)', () => {
    let workDir: string;

    setup(async () => {
        workDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-ioerror-'));
    });

    teardown(async () => {
        await fsPromises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const target: ApplyLockRequest = {
        targetId: 'git.global.http.proxy',
        targetHost: 'workspaceHost',
        scope: 'hostUser'
    };
    const ttlMs = 1000;

    function errnoError(code: string): NodeJS.ErrnoException {
        return Object.assign(new Error(`injected ${code}`), { code });
    }

    /**
     * Defines `process.getuid` for the scope of `run`, restoring the previous
     * own property (or its absence) afterwards. Windows has no `getuid`, so
     * rows that exercise the default uid source must install one (#108).
     */
    async function withTemporaryGetuid(uid: number, run: () => Promise<void>): Promise<void> {
        const previous = Object.getOwnPropertyDescriptor(process, 'getuid');
        Object.defineProperty(process, 'getuid', {
            configurable: true,
            writable: true,
            value: () => uid
        });
        try {
            await run();
        } finally {
            if (previous) {
                Object.defineProperty(process, 'getuid', previous);
            } else {
                delete (process as { getuid?: unknown }).getuid;
            }
        }
    }

    test('the POSIX default uses the per-user directory and creates it with mode 0700', async () => {
        const mkdirCalls: Array<{ dir: fs.PathLike; mode?: number }> = [];
        const fileSystem = {
            mkdirSync: (dir: fs.PathLike, options?: { mode?: number }) => {
                mkdirCalls.push({ dir, mode: options?.mode });
                return fs.mkdirSync(dir, options as fs.MakeDirectoryOptions);
            },
            lstatSync: (dir: fs.PathLike) => {
                const stat = fs.lstatSync(dir);
                // Windows reports no meaningful uid/mode; model the POSIX
                // answer so the owner/mode checks run the same everywhere.
                return {
                    ...stat,
                    isDirectory: () => stat.isDirectory(),
                    uid: 1000,
                    mode: 0o40700
                } as fs.Stats;
            }
        } as unknown as LockFileSystem;
        const service = new ApplyLockService({
            platform: 'linux',
            getuid: () => 1000,
            tmpdir: () => workDir,
            fileSystem
        });

        const result = await service.tryAcquire(target, ttlMs);

        const perUserDir = path.join(workDir, 'otak-proxy-1000');
        assert.ok(result.acquired && result.handle, JSON.stringify(result));
        assert.strictEqual(path.dirname(result.handle.path), perUserDir);
        assert.deepStrictEqual(mkdirCalls, [{ dir: perUserDir, mode: 0o700 }]);
        await service.release(result.handle);
    });

    test('a temp directory that changes after construction still checks and uses the cached directory', async () => {
        const mkdirCalls: fs.PathLike[] = [];
        const fileSystem = {
            mkdirSync: (dir: fs.PathLike, options?: { mode?: number }) => {
                mkdirCalls.push(dir);
                return fs.mkdirSync(dir, options as fs.MakeDirectoryOptions);
            },
            lstatSync: (dir: fs.PathLike) => {
                const stat = fs.lstatSync(dir);
                return {
                    ...stat,
                    isDirectory: () => stat.isDirectory(),
                    uid: 1000,
                    mode: 0o40700
                } as fs.Stats;
            }
        } as unknown as LockFileSystem;
        // TMPDIR changes after the service was built: the lock must stay in
        // the directory the service resolved, and that directory is the one
        // checked (Codex review on #121).
        let tmp = workDir;
        const service = new ApplyLockService({
            platform: 'linux',
            getuid: () => 1000,
            tmpdir: () => tmp,
            fileSystem
        });
        tmp = path.join(workDir, 'changed-tmpdir');

        const result = await service.tryAcquire(target, ttlMs);

        const perUserDir = path.join(workDir, 'otak-proxy-1000');
        assert.ok(result.acquired && result.handle, JSON.stringify(result));
        assert.strictEqual(path.dirname(result.handle.path), perUserDir);
        assert.deepStrictEqual(mkdirCalls, [perUserDir]);
        assert.strictEqual(fs.existsSync(tmp), false, 'nothing may be created under the new temp directory');
        await service.release(result.handle);
    });

    test('the POSIX default resolves the uid from process.getuid when no getuid option is given', async () => {
        await withTemporaryGetuid(4242, async () => {
            const fileSystem = {
                mkdirSync: fs.mkdirSync,
                lstatSync: (dir: fs.PathLike) => {
                    const stat = fs.lstatSync(dir);
                    // Model the POSIX answer so the owner/mode checks run the
                    // same on hosts (Windows) whose lstat reports neither.
                    return {
                        ...stat,
                        isDirectory: () => stat.isDirectory(),
                        uid: 4242,
                        mode: 0o40700
                    } as fs.Stats;
                }
            } as unknown as LockFileSystem;
            const service = new ApplyLockService({
                platform: 'linux',
                tmpdir: () => workDir,
                fileSystem
            });

            const result = await service.tryAcquire(target, ttlMs);

            assert.ok(result.acquired && result.handle, JSON.stringify(result));
            assert.strictEqual(path.dirname(result.handle.path), path.join(workDir, 'otak-proxy-4242'));
            await service.release(result.handle);
        });
    });

    test('the POSIX real default acquires a lock inside a 0700 per-user directory', async function() {
        if (process.platform === 'win32') {
            // Needs a real process.getuid and real POSIX mode bits; runs on
            // POSIX CI (ubuntu-latest).
            this.skip();
        }
        const service = new ApplyLockService({ tmpdir: () => workDir });

        const result = await service.tryAcquire(target, ttlMs);

        assert.ok(result.acquired && result.handle, JSON.stringify(result));
        const dir = path.join(workDir, `otak-proxy-${process.getuid!()}`);
        assert.strictEqual(path.dirname(result.handle.path), dir);
        assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'the per-user directory must be 0700');
        await service.release(result.handle);
    });

    test('the win32 default keeps the historical otak-proxy-v3-locks directory', async () => {
        const service = new ApplyLockService({ platform: 'win32', tmpdir: () => workDir });

        const result = await service.tryAcquire(target, ttlMs);

        assert.ok(result.acquired && result.handle, JSON.stringify(result));
        assert.strictEqual(path.dirname(result.handle.path), path.join(workDir, 'otak-proxy-v3-locks'));
        await service.release(result.handle);
    });

    test('a lock path override that is a regular file yields ioError, not a throw', async () => {
        const filePath = path.join(workDir, 'not-a-dir');
        await fsPromises.writeFile(filePath, 'x');
        const service = new ApplyLockService({ baseDir: filePath });

        const result = await service.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'ioError');
        assert.strictEqual(result.ioError?.why, 'notDirectory');
    });

    test('EACCES from mkdir yields ioError, not a throw', async () => {
        const service = new ApplyLockService({
            baseDir: path.join(workDir, 'denied'),
            fileSystem: {
                mkdirSync: () => { throw errnoError('EACCES'); },
                lstatSync: fs.lstatSync
            } as unknown as LockFileSystem
        });

        const result = await service.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'ioError');
        assert.strictEqual(result.ioError?.why, 'accessDenied');
    });

    for (const code of ['EACCES', 'EPERM'] as const) {
        test(`${code} from the exclusive open yields ioError, not a throw`, async () => {
            const baseDir = path.join(workDir, `open-${code.toLowerCase()}`);
            const service = new ApplyLockService({ baseDir });
            const originalOpen = fsPromises.open;
            let opened = 0;
            fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
                opened += 1;
                if (opened === 1) {
                    throw errnoError(code);
                }
                return originalOpen(...args);
            }) as typeof fsPromises.open;
            let result: Awaited<ReturnType<ApplyLockService['tryAcquire']>>;
            try {
                result = await service.tryAcquire(target, ttlMs);
            } finally {
                fsPromises.open = originalOpen;
            }

            assert.strictEqual(result.acquired, false);
            assert.strictEqual(result.reason, 'ioError');
            assert.strictEqual(result.ioError?.why, 'accessDenied');
        });
    }

    test('a per-user directory owned by another uid yields ioError', async () => {
        const service = new ApplyLockService({
            platform: 'linux',
            getuid: () => 1000,
            tmpdir: () => workDir,
            fileSystem: {
                mkdirSync: () => undefined,
                lstatSync: () => ({ isDirectory: () => true, uid: 2000, mode: 0o40700 } as fs.Stats)
            } as unknown as LockFileSystem
        });

        const result = await service.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'ioError');
        assert.strictEqual(result.ioError?.why, 'wrongOwner');
    });

    test('a non-Windows platform without getuid yields ioError', async () => {
        const service = new ApplyLockService({ platform: 'linux', getuid: null, tmpdir: () => workDir });

        const result = await service.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'ioError');
        assert.strictEqual(result.ioError?.why, 'noUid');
    });

    test('ENOSPC from mkdir still throws', async () => {
        const service = new ApplyLockService({
            baseDir: path.join(workDir, 'full'),
            fileSystem: {
                mkdirSync: () => { throw errnoError('ENOSPC'); },
                lstatSync: fs.lstatSync
            } as unknown as LockFileSystem
        });

        await assert.rejects(
            service.tryAcquire(target, ttlMs),
            (error: NodeJS.ErrnoException) => error.code === 'ENOSPC'
        );
    });
});
