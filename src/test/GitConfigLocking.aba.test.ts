/**
 * Mutual-exclusion tests for the Git config write mutex (#73).
 *
 * The mutex file used to carry no owner identity: staleness was judged from
 * mtime alone and release unlinked whatever file was there. A holder that
 * outlived the stale window therefore deleted the *next* holder's lock on its
 * way out, and two windows ended up inside the critical section at once - the
 * classic ABA.
 *
 * A Git write can legitimately run several sequential git invocations under one
 * acquisition, so exceeding the stale window is reachable, not theoretical.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import { GIT_CONFIG_MUTEX_PATH, withGitConfigWriteMutex } from '../config/GitConfigLocking';

/**
 * Simulates a holder whose heartbeat stopped: the lock keeps its owner token,
 * but its lease has not been refreshed for long enough to look abandoned.
 */
function ageLockFileBeyondStaleWindow(): void {
    const past = Date.now() - 10 * 60 * 1000;

    let record: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(GIT_CONFIG_MUTEX_PATH, 'utf-8'));
        record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
        record = null;
    }

    if (record) {
        fs.writeFileSync(
            GIT_CONFIG_MUTEX_PATH,
            JSON.stringify({ ...record, acquiredAt: past, heartbeatAt: past }),
            'utf-8'
        );
        return;
    }

    const pastDate = new Date(past);
    fs.utimesSync(GIT_CONFIG_MUTEX_PATH, pastDate, pastDate);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

suite('Git config write mutex ownership (#73)', () => {
    teardown(() => {
        try {
            fs.unlinkSync(GIT_CONFIG_MUTEX_PATH);
        } catch {
            // Ignore: the test may have left no lock behind.
        }
    });

    test('a slow holder does not release a lock it no longer owns', async () => {
        const secondHolderAcquired = deferred();
        const firstHolderReleased = deferred();
        let lockSurvivedFirstRelease: boolean | undefined;

        const first = withGitConfigWriteMutex(async () => {
            // This holder is still working when its lease looks abandoned.
            ageLockFileBeyondStaleWindow();
            await secondHolderAcquired.promise;
        });

        const second = withGitConfigWriteMutex(async () => {
            secondHolderAcquired.resolve();
            await firstHolderReleased.promise;
            lockSurvivedFirstRelease = fs.existsSync(GIT_CONFIG_MUTEX_PATH);
        });

        await first;
        firstHolderReleased.resolve();
        await second;

        assert.strictEqual(
            lockSurvivedFirstRelease,
            true,
            'the first holder must not delete the lock the second holder now owns'
        );
    });

    test('holders never overlap', async () => {
        let inside = 0;
        let maxInside = 0;

        const holder = async () => withGitConfigWriteMutex(async () => {
            inside += 1;
            maxInside = Math.max(maxInside, inside);
            await new Promise(resolve => setTimeout(resolve, 10));
            inside -= 1;
        });

        await Promise.all([holder(), holder(), holder()]);

        assert.strictEqual(maxInside, 1, 'the mutex must serialise its holders');
    });

    test('a lock abandoned by a crashed holder is reclaimed', async () => {
        // A pre-lease lock file: no token, no heartbeat, nothing to refresh it.
        // It must not wedge the feature.
        fs.writeFileSync(GIT_CONFIG_MUTEX_PATH, '', 'utf8');
        ageLockFileBeyondStaleWindow();

        let entered = false;
        await withGitConfigWriteMutex(async () => {
            entered = true;
        });

        assert.strictEqual(entered, true, 'an expired lock must be reclaimable');
    });
});
