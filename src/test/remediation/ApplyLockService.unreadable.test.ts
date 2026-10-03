import * as assert from 'assert';
import { PathLike, promises as fsPromises } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplyLockHandle, ApplyLockRequest, ApplyLockService } from '../../remediation/ApplyLockService';

/**
 * #93 item 3: a lock file left empty or truncated (the writer died between
 * `open('wx')` and the write) was treated as `held` forever, so every window
 * skipped apply with `lockSkipped`. An unreadable lock untouched for longer than
 * one lease is now reclaimed; a recently touched one is still `held` because a
 * live writer may be mid-write.
 */
suite('ApplyLockService unreadable lock recovery (#93)', () => {
    let baseDir: string;

    setup(async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-lock-unreadable-'));
    });

    teardown(async () => {
        await fs.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const target: ApplyLockRequest = {
        targetId: 'npm.user.proxy',
        targetHost: 'workspaceHost',
        scope: 'hostUser'
    };
    const ttlMs = 1000;

    /** Path the service uses for `target`, found by letting it create the lock once. */
    async function lockPathFor(service: ApplyLockService): Promise<string> {
        const probe = await service.tryAcquire(target, ttlMs);
        assert.ok(probe.acquired && probe.handle, 'probe must acquire the free lock');
        assert.strictEqual(await service.release(probe.handle), true);
        return probe.handle.path;
    }

    async function ageFile(file: string, ageMs: number): Promise<void> {
        const past = new Date(Date.now() - ageMs);
        await fs.utimes(file, past, past);
    }

    for (const [label, content] of [['an empty', ''], ['a truncated', '{"version":1,"tok']] as const) {
        test(`${label} lock older than the lease is reclaimed`, async () => {
            const service = new ApplyLockService({ baseDir });
            const lockPath = await lockPathFor(service);
            await fs.writeFile(lockPath, content, 'utf8');
            await ageFile(lockPath, ttlMs * 5);

            const result = await service.tryAcquire(target, ttlMs);

            assert.strictEqual(result.acquired, true, JSON.stringify(result));
            assert.ok(result.handle);
            const written = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
            assert.strictEqual(written.token, result.handle.token, 'the reclaimed path must hold the new record');
            const leftovers = (await fs.readdir(baseDir)).filter(name => name.includes('.stale.'));
            assert.deepStrictEqual(leftovers, [], 'the stale copy must be removed');
            assert.strictEqual(await service.release(result.handle), true);
        });

        test(`${label} lock touched within the lease is still held`, async () => {
            const service = new ApplyLockService({ baseDir });
            const lockPath = await lockPathFor(service);
            await fs.writeFile(lockPath, content, 'utf8');

            const result = await service.tryAcquire(target, ttlMs);

            assert.strictEqual(result.acquired, false);
            assert.strictEqual(result.reason, 'held');
            assert.strictEqual(await fs.readFile(lockPath, 'utf8'), content, 'a possibly live lock must not be touched');
        });
    }

    test('the record clock does not decide the age of an unreadable lock', async () => {
        // The injectable clock models record expiry; an unreadable file has no
        // record, so a far-future record clock must not make a fresh file look old.
        const service = new ApplyLockService({ baseDir, now: () => Date.now() + ttlMs * 100 });
        const lockPath = await lockPathFor(service);
        await fs.writeFile(lockPath, '', 'utf8');

        const result = await service.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'held');
    });

    test('a readable live lock is still held, whatever its mtime', async () => {
        const holder = new ApplyLockService({ baseDir });
        const competitor = new ApplyLockService({ baseDir });
        const acquired = await holder.tryAcquire(target, ttlMs * 60);
        assert.ok(acquired.acquired && acquired.handle);
        await ageFile(acquired.handle.path, ttlMs * 5);

        const result = await competitor.tryAcquire(target, ttlMs);

        assert.strictEqual(result.acquired, false);
        assert.strictEqual(result.reason, 'held');
        assert.strictEqual(await holder.release(acquired.handle), true);
    });

    test('a failed write after the exclusive create removes the new file and still throws', async () => {
        const service = new ApplyLockService({ baseDir });
        const lockPath = await lockPathFor(service);

        // FileHandle is not exported, so reach its prototype through a real handle
        // and make the next lock write fail (disk full / I/O error).
        const scratch = await fs.open(path.join(baseDir, 'scratch.txt'), 'w');
        const prototype = Object.getPrototypeOf(scratch) as { writeFile: (...args: unknown[]) => Promise<void> };
        await scratch.close();
        const originalWriteFile = prototype.writeFile;
        prototype.writeFile = async () => {
            const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
            error.code = 'ENOSPC';
            throw error;
        };
        try {
            await assert.rejects(service.tryAcquire(target, ttlMs), (error: NodeJS.ErrnoException) => error.code === 'ENOSPC');
        } finally {
            prototype.writeFile = originalWriteFile;
        }

        await assert.rejects(fs.stat(lockPath), (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
            'the empty lock must not be left behind');
        const next = await service.tryAcquire(target, ttlMs);
        assert.strictEqual(next.acquired, true, 'the next attempt must not be blocked by our own failed write');
        assert.ok(next.handle);
        assert.strictEqual(await service.release(next.handle), true);
    });

    test('a reclaim that would move a peer\'s fresh lock puts it back and reports contention', async () => {
        const service = new ApplyLockService({ baseDir });
        const peer = new ApplyLockService({ baseDir });
        const lockPath = await lockPathFor(service);
        await fs.writeFile(lockPath, '', 'utf8');
        await ageFile(lockPath, ttlMs * 5);

        // Model the race: right before our rename, a peer that also saw the
        // abandoned file reclaims it and creates its own lock in its place.
        const originalRename = fsPromises.rename;
        let peerHandle: ApplyLockHandle | undefined;
        fsPromises.rename = (async (from: PathLike, to: PathLike) => {
            fsPromises.rename = originalRename;
            peerHandle = (await peer.tryAcquire(target, ttlMs)).handle;
            return originalRename(from, to);
        }) as typeof fsPromises.rename;
        let result: Awaited<ReturnType<ApplyLockService['tryAcquire']>>;
        try {
            result = await service.tryAcquire(target, ttlMs);
        } finally {
            fsPromises.rename = originalRename;
        }

        assert.ok(peerHandle, 'the peer must have reclaimed first');
        assert.strictEqual(result.acquired, false, JSON.stringify(result));
        assert.strictEqual(result.reason, 'held');
        const onDisk = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
        assert.strictEqual(onDisk.token, peerHandle.token, 'the peer\'s lock must be back in place');
        const leftovers = (await fs.readdir(baseDir)).filter(name => name.includes('.stale.'));
        assert.deepStrictEqual(leftovers, []);
        assert.strictEqual(await peer.release(peerHandle), true);
    });
});
