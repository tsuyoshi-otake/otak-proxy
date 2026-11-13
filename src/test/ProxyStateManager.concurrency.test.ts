/**
 * Reads and writes of ProxyStateManager that overlap on SecretStorage (#130).
 *
 * getState() hydrates credentials from SecretStorage and commitState() stores
 * them there, so both wait in the middle. These tests hold a SecretStorage
 * read open and let the other operation run through the gap.
 */
import * as assert from 'assert';
import { ProxyMode, ProxyState, stateRevision } from '../core/types';
import { createRealStateManager, RealStateManagerHarness } from './realProxyStateManager';

const DEADLINE_MS = 1500;

function withDeadline<T>(what: string, promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`deadlock: ${what} did not settle within ${DEADLINE_MS} ms`)),
            DEADLINE_MS
        );
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

interface SecretReadGate {
    /** Later SecretStorage reads wait until release(). */
    hold(): void;
    release(): void;
    waiting(): number;
}

function gateSecretReads(harness: RealStateManagerHarness): SecretReadGate {
    const secrets = harness.extensionContext.secrets as unknown as {
        get: (key: string) => Promise<string | undefined>;
    };
    const read = secrets.get;
    let held = false;
    let waiters: Array<() => void> = [];
    secrets.get = async (key: string) => {
        if (held) {
            await new Promise<void>(resolve => waiters.push(resolve));
        }
        return read(key);
    };
    return {
        hold: () => { held = true; },
        release: () => {
            held = false;
            const parked = waiters;
            waiters = [];
            parked.forEach(resolve => resolve());
        },
        waiting: () => waiters.length
    };
}

async function untilParked(gate: SecretReadGate): Promise<void> {
    for (let turn = 0; turn < 200 && gate.waiting() === 0; turn++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(gate.waiting() > 0, 'the read must be waiting on SecretStorage');
}

async function seedAuto(harness: RealStateManagerHarness): Promise<ProxyState> {
    await harness.manager.getState();
    await harness.manager.saveState({ mode: ProxyMode.Auto, autoProxyUrl: 'http://proxy.example:8080' });
    return harness.manager.getState();
}

suite('ProxyStateManager overlapping reads and writes (#130)', () => {
    test('a read that hydrates across a commit does not roll the commit back', async () => {
        const harness = createRealStateManager();
        const before = await seedAuto(harness);
        const gate = gateSecretReads(harness);

        gate.hold();
        const reader = harness.manager.getState();
        await untilParked(gate);

        // This commit stores no credential, so it reads nothing from
        // SecretStorage and completes while the reader is still parked.
        const commit = await withDeadline(
            'the commit',
            harness.manager.commitState(stateRevision(before), { ...before, mode: ProxyMode.Off })
        );
        assert.strictEqual(commit.kind, 'committed');

        gate.release();
        const seen = await withDeadline('the parked reader', reader);
        const after = await withDeadline('the final read', harness.manager.getState());

        assert.strictEqual(after.mode, ProxyMode.Off, 'the committed mode stays in memory');
        assert.strictEqual(stateRevision(after), stateRevision(before) + 1, 'the committed revision stays in memory');
        assert.strictEqual(harness.persistedState()?.mode, ProxyMode.Off);
        assert.strictEqual(seen.mode, ProxyMode.Off, 'the reader returns the state committed while it waited');
        assert.strictEqual(stateRevision(seen), stateRevision(before) + 1);

        // The next commit is checked against the committed revision.
        const stale = await harness.manager.commitState(stateRevision(before), { ...before, lastTestTimestamp: 1 });
        assert.strictEqual(stale.kind, 'superseded');
    });

    test('two commits at the same revision: one commits, the other is superseded', async () => {
        const harness = createRealStateManager();
        const before = await seedAuto(harness);
        const revision = stateRevision(before);

        const [first, second] = await withDeadline('both commits', Promise.all([
            harness.manager.commitState(revision, { ...before, mode: ProxyMode.Off }),
            harness.manager.commitState(revision, { ...before, lastTestTimestamp: 123 })
        ]));

        assert.deepStrictEqual([first.kind, second.kind], ['committed', 'superseded']);
        const after = await harness.manager.getState();
        assert.strictEqual(after.mode, ProxyMode.Off, 'the superseded commit wrote nothing');
        assert.strictEqual(after.lastTestTimestamp, undefined);
        assert.strictEqual(stateRevision(after), revision + 1);
    });

    test('a save queued behind a commit takes the next revision instead of reusing it', async () => {
        const harness = createRealStateManager();
        const before = await seedAuto(harness);
        const revision = stateRevision(before);

        const committing = harness.manager.commitState(revision, { ...before, mode: ProxyMode.Off });
        const saving = harness.manager.saveState({ ...before, lastTestTimestamp: 7 });
        assert.strictEqual((await withDeadline('the commit', committing)).kind, 'committed');
        await withDeadline('the save', saving);

        const after = await harness.manager.getState();
        assert.strictEqual(stateRevision(after), revision + 2);
        assert.strictEqual(after.lastTestTimestamp, 7);
    });
});
