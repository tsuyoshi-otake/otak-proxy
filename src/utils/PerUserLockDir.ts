import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One owner for the directory this extension's shared temp locks live in
 * (#108).
 *
 * On a shared POSIX `/tmp` every user would otherwise write locks into the
 * same `otak-proxy` directory: the first user's umask decides who may enter
 * it, and a second user's applies and Git writes fail with EACCES (or wedge
 * retrying a lock file they cannot reclaim inside a sticky directory). POSIX
 * therefore gets a per-user directory `<tmpdir>/otak-proxy-<uid>` created
 * 0700; the apply locks and the Git config mutex both live directly under it.
 * Windows keeps the historical paths unchanged because its temp directory is
 * already per-user, so existing installs keep sharing their locks.
 *
 * `process.getuid()` is used rather than `os.userInfo()`, which throws when
 * the account has no passwd entry.
 */

export interface LockDirDeps {
    platform?: NodeJS.Platform;
    /**
     * Absent or `undefined` uses `process.getuid`; `null` means "this platform
     * has no uid" (test seam). A throwing function also resolves to no uid.
     */
    getuid?: (() => number) | null;
    tmpdir?: () => string;
    fileSystem?: Pick<typeof fs, 'mkdirSync' | 'lstatSync'>;
}

/** Why a lock directory cannot be used; every value maps to the `ioError` lock outcome. */
export type LockDirUnusableWhy =
    /** There is no `getuid` on a non-Windows platform, or it threw. */
    | 'noUid'
    /** EACCES or EPERM from `mkdir` or `lstat`. */
    | 'accessDenied'
    /** The path exists but is not a real directory (a symlink counts as not a directory). */
    | 'notDirectory'
    /** The POSIX per-user directory is owned by another uid. */
    | 'wrongOwner'
    /** The POSIX per-user directory has group/other permission bits. */
    | 'insecureMode';

export type LockDirStatus =
    | { usable: true; dir: string }
    | { usable: false; dir: string; why: LockDirUnusableWhy };

const PER_USER_DIR_PREFIX = 'otak-proxy-';
const PER_USER_DIR_MODE = 0o700;
/** Group and other permission bits that must not be set on a per-user dir. */
const INSECURE_MODE_MASK = 0o077;

function resolvedPlatform(deps?: LockDirDeps): NodeJS.Platform {
    return deps?.platform ?? process.platform;
}

function resolvedTmpdir(deps?: LockDirDeps): string {
    return (deps?.tmpdir ?? os.tmpdir)();
}

function resolvedUid(deps?: LockDirDeps): number | undefined {
    const getuid = deps?.getuid === undefined ? process.getuid : deps.getuid;
    if (!getuid) {
        return undefined;
    }
    try {
        return getuid.call(process);
    } catch {
        return undefined;
    }
}

function isErrno(error: unknown, ...codes: string[]): boolean {
    return codes.includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/**
 * The directory this extension's shared temp locks live under for the current
 * user. POSIX: `<tmpdir>/otak-proxy-<uid>`. Windows, or POSIX without a uid:
 * `<tmpdir>` itself — the path still computes so callers keep a stable
 * location, but `ensurePerUserLockDir` reports it unusable, never silently
 * shared.
 */
export function perUserLockDirPath(deps?: LockDirDeps): string {
    const tmp = resolvedTmpdir(deps);
    if (resolvedPlatform(deps) === 'win32') {
        return tmp;
    }
    const uid = resolvedUid(deps);
    return uid === undefined ? tmp : path.join(tmp, `${PER_USER_DIR_PREFIX}${uid}`);
}

/**
 * Creates `dir` if needed and judges whether it can hold this extension's
 * locks. Every lock directory (per-user default, `OTAK_PROXY_LOCK_DIR` /
 * `baseDir` override, Windows default) gets the real-directory check; the
 * owner and mode checks apply only when `ownerUid` is given — that is, only
 * for the POSIX per-user default, which is created with mode 0700.
 *
 * EACCES/EPERM from `mkdir` or `lstat` yields `accessDenied`; any other errno
 * (ENOSPC, EIO, ENOTDIR, ...) is thrown unchanged. There is a deliberate
 * lstat-then-open residual: nothing pins the directory between this check
 * and the lock create.
 */
export function ensureLockDir(
    dir: string,
    ownerUid: number | undefined,
    deps?: LockDirDeps
): LockDirStatus {
    const fileSystem = deps?.fileSystem ?? fs;
    try {
        fileSystem.mkdirSync(dir, {
            recursive: true,
            ...(ownerUid !== undefined ? { mode: PER_USER_DIR_MODE } : {})
        });
    } catch (error) {
        if (isErrno(error, 'EEXIST')) {
            // The path exists; the lstat check below judges what it is.
        } else if (isErrno(error, 'EACCES', 'EPERM')) {
            return { usable: false, dir, why: 'accessDenied' };
        } else {
            throw error;
        }
    }

    let stat: fs.Stats;
    try {
        stat = fileSystem.lstatSync(dir);
    } catch (error) {
        if (isErrno(error, 'EACCES', 'EPERM')) {
            return { usable: false, dir, why: 'accessDenied' };
        }
        throw error;
    }

    if (!stat.isDirectory()) {
        return { usable: false, dir, why: 'notDirectory' };
    }
    if (ownerUid !== undefined) {
        if (stat.uid !== ownerUid) {
            return { usable: false, dir, why: 'wrongOwner' };
        }
        if ((stat.mode & INSECURE_MODE_MASK) !== 0) {
            return { usable: false, dir, why: 'insecureMode' };
        }
    }
    return { usable: true, dir };
}

/**
 * Ensures the per-user lock directory exists and is safe to use. Windows is
 * unconditionally usable (its temp directory is already per-user). POSIX
 * fails closed: without a uid there is no safe fallback directory, so the
 * callers report the unusable directory through their existing error
 * channels instead of falling back to a shared one.
 */
export function ensurePerUserLockDir(deps?: LockDirDeps): LockDirStatus {
    const tmp = resolvedTmpdir(deps);
    if (resolvedPlatform(deps) === 'win32') {
        return { usable: true, dir: tmp };
    }
    const uid = resolvedUid(deps);
    if (uid === undefined) {
        return { usable: false, dir: tmp, why: 'noUid' };
    }
    return ensureLockDir(path.join(tmp, `${PER_USER_DIR_PREFIX}${uid}`), uid, deps);
}
