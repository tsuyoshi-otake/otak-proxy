/**
 * #108 item 4: the Git config mutex lives in the same per-user lock directory
 * as the apply locks. When that directory is unusable the write must not fall
 * back to a shared path or rely on the filesystem refusing it — the mutex
 * fails through the EACCES channel and the Git write reports NO_PERMISSION.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { GIT_CONFIG_MUTEX_PATH, withGitConfigWriteMutex } from '../config/GitConfigLocking';
import { GitConfigManager } from '../config/GitConfigManager';
import { classifyGitConfigError } from '../config/GitConfigErrorClassifier';
import * as PerUserLockDir from '../utils/PerUserLockDir';

suite('Git config mutex lock directory (#108)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
        try {
            fs.unlinkSync(GIT_CONFIG_MUTEX_PATH);
        } catch {
            // Ignore: no lock was created.
        }
    });

    test('an unusable lock directory rejects before the callback and creates no mutex file', async () => {
        sandbox.stub(PerUserLockDir, 'ensurePerUserLockDir')
            .returns({ usable: false, dir: '/tmp/otak-proxy-2000', why: 'wrongOwner' });
        let entered = false;

        await assert.rejects(
            withGitConfigWriteMutex(async () => { entered = true; }),
            (error: NodeJS.ErrnoException) =>
                error.code === 'EACCES' &&
                error.message.includes('/tmp/otak-proxy-2000') &&
                error.message.includes('wrongOwner')
        );

        assert.strictEqual(entered, false, 'the critical section must not run without the mutex');
        assert.strictEqual(fs.existsSync(GIT_CONFIG_MUTEX_PATH), false, 'no mutex file may be created');
    });

    test('the check judges the directory of the cached mutex path', async () => {
        // TMPDIR may change after the module is loaded; the mutex path does
        // not, so the directory checked must be the mutex's own (Codex review
        // on #121).
        const ensure = sandbox.stub(PerUserLockDir, 'ensurePerUserLockDir')
            .returns({ usable: false, dir: path.dirname(GIT_CONFIG_MUTEX_PATH), why: 'wrongOwner' });

        await assert.rejects(withGitConfigWriteMutex(async () => undefined));

        assert.strictEqual(ensure.callCount, 1);
        assert.strictEqual(ensure.firstCall.args[1], path.dirname(GIT_CONFIG_MUTEX_PATH));
    });

    test('a Git write on an unusable lock directory reports NO_PERMISSION', async () => {
        sandbox.stub(PerUserLockDir, 'ensurePerUserLockDir')
            .returns({ usable: false, dir: '/tmp/otak-proxy-2000', why: 'wrongOwner' });
        let runnerCalled = false;
        const manager = new GitConfigManager({
            commandRunner: async () => {
                runnerCalled = true;
                throw new Error('git must not run when the lock directory is unusable');
            }
        });

        const result = await manager.setProxy('http://proxy.example.com:8080');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.errorType, 'NO_PERMISSION');
        assert.strictEqual(runnerCalled, false);
        assert.strictEqual(fs.existsSync(GIT_CONFIG_MUTEX_PATH), false);
    });

    test('EPERM classifies as NO_PERMISSION like EACCES', () => {
        const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

        for (const error of [eperm, eacces]) {
            const classification = classifyGitConfigError(error, 1000);
            assert.strictEqual(classification.errorType, 'NO_PERMISSION', `code ${error.code}`);
        }
    });
});
