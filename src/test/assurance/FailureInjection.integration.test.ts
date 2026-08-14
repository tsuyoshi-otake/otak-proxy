import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProxyConfigTarget } from '../../core/ProxyApplierTypes';
import { updateProxyConfigTargetDetailed } from '../../core/ProxyConfigTargetRunner';
import { ProxyMode } from '../../core/types';
import { ErrorAggregator } from '../../errors/ErrorAggregator';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { ProxyMonitor } from '../../monitoring/ProxyMonitor';
import { ISystemProxyDetector, ProxyCheckTrigger, ProxyDetectionResult } from '../../monitoring/ProxyMonitorTypes';
import { detectProxyWithRetry } from '../../monitoring/ProxyMonitorDetection';
import { ApplyLockService } from '../../remediation/ApplyLockService';
import { ConflictResolver, SyncableState } from '../../sync/ConflictResolver';
import { SharedStateFile, SharedStateFileSystem } from '../../sync/SharedStateFile';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function errno(code: string): Error & { code: string } {
    return Object.assign(new Error(`injected ${code}`), { code }) as Error & { code: string };
}

function failureFileSystem(overrides: Partial<SharedStateFileSystem>): SharedStateFileSystem {
    return { ...fs, ...overrides } as SharedStateFileSystem;
}

function sharedState(version: number, actor = 'actor-a') {
    return {
        version,
        lastModified: version,
        lastModifiedBy: actor,
        proxyState: { mode: ProxyMode.Auto, autoProxyUrl: `safe://proxy/${version}` }
    };
}

suite('Assurance: deterministic failure injection and recovery', () => {
    test('F-RESOURCE-001: ENOSPC and EACCES produce an explicit filesystem failure with no durable state', async () => {
        for (const code of ['ENOSPC', 'EACCES']) {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), `otak-assurance-${code.toLowerCase()}-`));
            const stateFile = new SharedStateFile(directory, {
                fileSystem: failureFileSystem({
                    writeFileSync: () => { throw errno(code); }
                })
            });
            try {
                await assert.rejects(stateFile.write(sharedState(1)), (error: unknown) =>
                    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
                );
                assert.strictEqual(await stateFile.exists(), false);
            } finally {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }
    });

    test('F-PERSIST-RETRY-001: EPERM rename retries are bounded and recover after the fault clears', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-assurance-rename-'));
        let attempts = 0;
        const sleeps: number[] = [];
        const stateFile = new SharedStateFile(directory, {
            fileSystem: failureFileSystem({
                renameSync: ((from: string, to: string) => {
                    attempts++;
                    if (attempts < 3) {
                        throw errno('EPERM');
                    }
                    return fs.renameSync(from, to);
                }) as typeof fs.renameSync
            }),
            sleep: async ms => { sleeps.push(ms); }
        });
        try {
            await stateFile.write(sharedState(2));
            assert.strictEqual(attempts, 3);
            assert.deepStrictEqual(sleeps, [25, 25]);
            assert.strictEqual((await stateFile.read())?.version, 2);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('F-PARTIAL-001: one target failure stays visible while other target results remain terminal', async () => {
        const successTarget: ProxyConfigTarget = {
            name: 'Terminal environment',
            manager: {
                setProxy: async () => ({ success: true }),
                unsetProxy: async () => ({ success: true })
            }
        };
        const failedTarget: ProxyConfigTarget = {
            name: 'VSCode configuration',
            manager: {
                setProxy: async () => ({ success: false, error: 'write rejected', errorType: 'CONFIG_ERROR' }),
                unsetProxy: async () => ({ success: false, error: 'write rejected', errorType: 'CONFIG_ERROR' })
            }
        };
        const errors = new ErrorAggregator();
        const [success, failure] = await Promise.all([
            updateProxyConfigTargetDetailed(successTarget, true, 'safe://proxy/partial', errors),
            updateProxyConfigTargetDetailed(failedTarget, true, 'safe://proxy/partial', errors)
        ]);
        assert.deepStrictEqual(success, { success: true, outcome: 'configured' });
        assert.deepStrictEqual(failure, { success: false, outcome: 'failed', errorType: 'CONFIG_ERROR' });
        assert.strictEqual(errors.hasErrors(), true);
    });

    test('F-DETECT-RETRY-001: detector retry resets on success and reports an explicit terminal failure at the bound', async () => {
        let attempts = 0;
        const waits: number[] = [];
        const eventuallyHealthy: ISystemProxyDetector = {
            detectSystemProxy: async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Error('transient');
                }
                return 'safe://proxy/recovered';
            }
        };
        const success = await detectProxyWithRetry({
            detector: eventuallyHealthy,
            config: {
                pollingInterval: 1,
                debounceDelay: 0,
                maxRetries: 2,
                retryBackoffBase: 1,
                detectionSourcePriority: [],
                enableConnectionTest: false,
                connectionTestInterval: 1
            },
            trigger: 'network',
            sleep: async ms => { waits.push(ms); },
            onAllRetriesFailed: () => assert.fail('success must not report an exhausted retry')
        });
        assert.strictEqual(success.success, true);
        assert.strictEqual(attempts, 2);
        assert.deepStrictEqual(waits, [1_000]);

        let exhausted = 0;
        const failure = await detectProxyWithRetry({
            detector: { detectSystemProxy: async () => { throw new Error('still unavailable'); } },
            config: {
                pollingInterval: 1,
                debounceDelay: 0,
                maxRetries: 1,
                retryBackoffBase: 1,
                detectionSourcePriority: [],
                enableConnectionTest: false,
                connectionTestInterval: 1
            },
            trigger: 'network',
            sleep: async () => undefined,
            onAllRetriesFailed: () => { exhausted++; }
        });
        assert.strictEqual(failure.success, false);
        assert.strictEqual(exhausted, 1);
    });

    test('F-EVENT-001: duplicate, missing and reordered sync events converge to the newest state', () => {
        const resolver = new ConflictResolver();
        const oldState: SyncableState = { state: { mode: ProxyMode.Off }, timestamp: 10, instanceId: 'a', version: 1 };
        const newestState: SyncableState = { state: { mode: ProxyMode.Auto }, timestamp: 20, instanceId: 'b', version: 2 };
        let current = oldState;
        for (const event of [newestState, oldState, newestState]) {
            const resolution = resolver.resolve(current, event);
            if (resolution.winner === 'remote') {
                current = resolution.resolvedState;
            }
        }
        assert.strictEqual(current.timestamp, newestState.timestamp);
        assert.strictEqual(current.state.mode, ProxyMode.Auto);

        // A missing old event is also safe: direct delivery of the newer revision converges.
        const direct = resolver.resolve(oldState, newestState);
        assert.strictEqual(direct.winner, 'remote');
    });

    test('F-CANCEL-001: ProxyMonitor discards an in-flight completion after stop', async () => {
        const pending = deferred<string | null>();
        const detector: ISystemProxyDetector = { detectSystemProxy: async () => pending.promise };
        const logger = new ProxyChangeLogger({ maskPassword: value => value });
        const monitor = new ProxyMonitor(detector, logger, {
            pollingInterval: 60_000,
            debounceDelay: 1,
            maxRetries: 0,
            enableConnectionTest: false
        });
        const emitted: ProxyDetectionResult[] = [];
        monitor.on('checkComplete', result => emitted.push(result as ProxyDetectionResult));
        monitor.start();
        const execute = (monitor as unknown as {
            executeCheck(trigger: ProxyCheckTrigger): Promise<ProxyDetectionResult>;
        }).executeCheck('network');
        await new Promise<void>(resolve => setImmediate(resolve));
        monitor.stop();
        pending.resolve('safe://proxy/late');
        const result = await execute;
        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /discarded/u);
        assert.deepStrictEqual(emitted, []);
        assert.deepStrictEqual(logger.getChangeHistory(), []);
        assert.strictEqual(monitor.getState().isActive, false);
    });

    test('F-CRASH-001: corrupt shared state and stale lease recover after restart', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-assurance-recovery-'));
        let now = 0;
        const lockTarget = { targetId: 'proxy', targetHost: 'workspaceHost' as const, scope: 'hostUser' as const };
        try {
            const shared = new SharedStateFile(directory);
            await shared.write(sharedState(1));
            fs.writeFileSync(shared.getFilePath(), '{ interrupted', 'utf8');
            fs.writeFileSync(path.join(shared.getSyncDir(), 'sync-state.crash.tmp'), 'partial', 'utf8');
            assert.strictEqual(await shared.recover(), true);
            assert.strictEqual(await shared.exists(), false);

            const firstService = new ApplyLockService({ baseDir: directory, now: () => now });
            const first = await firstService.tryAcquire(lockTarget, 5);
            assert.strictEqual(first.acquired, true);
            assert.ok(first.handle);
            const held = await new ApplyLockService({ baseDir: directory, now: () => now }).tryAcquire(lockTarget, 5);
            assert.deepStrictEqual(held.acquired, false);
            assert.strictEqual(held.reason, 'held');
            now = 6;
            const recovered = await new ApplyLockService({ baseDir: directory, now: () => now }).tryAcquire(lockTarget, 5);
            assert.strictEqual(recovered.acquired, true);
            assert.ok(recovered.handle);
            assert.strictEqual(await firstService.release(first.handle!), false, 'stale owner must not release the new lease');
            assert.strictEqual(await new ApplyLockService({ baseDir: directory, now: () => now }).release(recovered.handle!), true);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
