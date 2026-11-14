/**
 * @file SyncManager
 * @description Central coordinator for multi-instance synchronization
 *
 * Feature: multi-instance-sync
 * Requirements: 1.1-1.4, 2.1-2.5, 3.1-3.3, 7.1-7.5
 *
 * Provides:
 * - Instance lifecycle management
 * - State change propagation
 * - Remote change detection and application
 * - Error handling and recovery
 */

import { EventEmitter } from 'events';
import { ProxyState, stateRevision } from '../core/types';
import { Logger } from '../utils/Logger';
import { SharedStateFile, SharedState, ISharedStateFile } from './SharedStateFile';
import { InstanceRegistry, IInstanceRegistry } from './InstanceRegistry';
import { FileWatcher, IFileWatcher } from './FileWatcher';
import { ConflictResolver, SyncableState } from './ConflictResolver';
import { ISyncConfigManager } from './SyncConfigManager';
import { sanitizeProxyStateForPersistence, stripConvergencePendingToken } from '../utils/ProxyStateSanitizer';
import { ISyncManager, SyncResult, SyncStatus } from './SyncTypes';
import { reconcileSharedState, RemoteSyncDelivery } from './SyncReconciler';
import { SyncManagerTimers } from './SyncManagerTimers';
import { handleSyncConfigChange } from './SyncConfigChangeHandler';

export type { ISyncManager, SyncResult, SyncStatus } from './SyncTypes';

/**
 * A failed snapshot publish is retried on a bounded exponential schedule
 * (#137): the commit was decided; only its delivery to the shared file
 * failed. Bounded so a dead share cannot burn CPU or block remote adoptions
 * forever, jittered so two windows do not retry in lockstep.
 */
const PUBLISH_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];
const PUBLISH_RETRY_JITTER = 0.25;

/**
 * The decided-but-undelivered local commit and its retry bookkeeping (#137).
 * The retry loop passes the record itself into publishState so a stale
 * compare-and-swap can tell "the pending that scheduled me is still current"
 * from one a newer commit replaced mid-flight.
 */
interface PendingPublish {
    state: ProxyState;
    snapshotRevision: number;
    attempts: number;
    generation: number;
}

/**
 * SyncManager coordinates synchronization between multiple otak-proxy instances.
 *
 * Architecture:
 * - Uses SharedStateFile for persistent state storage
 * - Uses InstanceRegistry for tracking active instances
 * - Uses FileWatcher for detecting remote changes
 * - Uses ConflictResolver for handling concurrent updates
 */
export class SyncManager extends EventEmitter implements ISyncManager {
    private readonly sharedStateFile: ISharedStateFile;
    private readonly instanceRegistry: IInstanceRegistry;
    private readonly fileWatcher: IFileWatcher;
    private readonly conflictResolver: ConflictResolver;
    private readonly configManager: ISyncConfigManager;
    private readonly timers: SyncManagerTimers;

    private isStarted: boolean = false;
    private isSyncing: boolean = false;
    private activeInstances: number = 0;
    private lastSyncTime: number | null = null;
    private lastError: string | null = null;
    private currentState: SyncableState | null = null;
    private remoteChangeInProgress: boolean = false;
    /**
     * The highest revision of a state this window published or adopted
     * (#108). `revision` is a per-window counter: it is only ever compared
     * against this window's own history, so a snapshot older than something
     * this window already published or adopted is stale, while another
     * window's counter never blocks a publication.
     */
    private localHistoryRevision: number = 0;
    /**
     * The highest shared-file `version` this window published or adopted
     * (#108). A delivery whose version is not above it is superseded.
     */
    private highestSharedVersion: number = 0;
    /**
     * Short serialized section for this window's shared-history transitions:
     * snapshot publications, reasserts and adoptions (version check + save +
     * fence/watermark update). Tasks here never await an apply, monitoring,
     * the monitor event queue, the delivery chain or another publication, so
     * the section cannot self-wait (#108).
     */
    private transitionQueue: Promise<void> = Promise.resolve();
    /**
     * Remote deliveries are converged one at a time in emission order — the
     * delivery task is the whole applyRemoteSyncState run after adoption
     * (credential gate, apply, monitoring, status). The adoption itself is
     * decided at emission on the transition section, so a queued delivery
     * already moved the fence and the watermark long before its convergence
     * starts. No coalescing (#108).
     */
    private deliveryQueue: Promise<void> = Promise.resolve();
    /**
     * On-disk revision of the shared state file as of the last reconcile.
     * Lets the periodic poll skip read + parse while nothing has been written.
     */
    private lastObservedFileSignature: string | null = null;
    /**
     * The decided-but-undelivered local commit and its retry bookkeeping
     * (#137). While set, remote adoptions are skipped: saving a remote state
     * would silently overwrite the commit the retries are still delivering.
     */
    private pendingPublish: PendingPublish | null = null;
    private publishRetryTimer: NodeJS.Timeout | null = null;
    private publishRetrySeq = 0;
    private publishRetryDelaysMs: readonly number[] = PUBLISH_RETRY_DELAYS_MS;
    private publishRetryRandom: () => number = Math.random;

    /**
     * Create a new SyncManager
     *
     * @param baseDir Base directory for sync files
     * @param windowId VSCode window identifier
     * @param configManager Configuration manager
     */
    constructor(
        baseDir: string,
        windowId: string,
        configManager: ISyncConfigManager,
        extensionVersion: string = 'unknown'
    ) {
        super();

        this.configManager = configManager;

        // Initialize components
        this.sharedStateFile = new SharedStateFile(baseDir);
        this.instanceRegistry = new InstanceRegistry(baseDir, windowId, extensionVersion);
        this.fileWatcher = new FileWatcher();
        this.conflictResolver = new ConflictResolver();
        this.timers = new SyncManagerTimers(
            this.instanceRegistry,
            this.configManager,
            () => this.pollRemoteChange(),
            () => void this.refreshActiveInstances()
        );

        // Set up file change handler
        this.fileWatcher.on('change', () => void this.handleRemoteChange());

        // Set up config change handler
        this.configManager.onConfigChange((key, value) => {
            this.handleConfigChange(key, value);
        });
    }

    /**
     * Start the sync service
     *
     * @returns True if started successfully
     */
    async start(deliverLoadedSharedState: boolean = false): Promise<boolean> {
        // Check if sync is enabled in configuration
        if (!this.configManager.isSyncEnabled()) {
            Logger.log('Sync is disabled in configuration, running in standalone mode');
            return true;
        }

        if (this.isStarted) {
            Logger.log('SyncManager already started');
            return true;
        }

        try {
            // Register this instance
            const registered = await this.instanceRegistry.register();
            if (!registered) {
                Logger.error('Failed to register instance');
                return false;
            }

            // Start file watcher
            const filePath = this.sharedStateFile.getFilePath();
            this.fileWatcher.start(filePath);

            this.timers.startLifecycleTimers();

            // Load initial state
            const loadedSharedState = await this.loadInitialState();

            // Populate cached instance count for synchronous status reporting.
            await this.refreshActiveInstances();

            this.isStarted = true;
            this.timers.reschedulePeriodicSync();
            this.emitStatusChanged();

            if (deliverLoadedSharedState && loadedSharedState) {
                // A start triggered by enabling sync at runtime adopts the
                // shared state exactly like the startup path does: the loaded
                // file is delivered through the same remoteChange channel a
                // watcher delivery uses, so it is adopted and converged
                // instead of being silently overwritten by this window's next
                // publication (#137).
                this.emit('remoteChange', {
                    state: loadedSharedState.proxyState,
                    version: loadedSharedState.version
                });
            }

            Logger.log('SyncManager started successfully');
            return true;
        } catch (error) {
            Logger.error('Failed to start SyncManager:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            return false;
        }
    }

    /**
     * Stop the sync service
     */
    async stop(): Promise<void> {
        if (!this.isStarted) {
            return;
        }

        try {
            this.timers.stopAll();
            this.clearPendingPublishRetry();

            // Stop file watcher
            this.fileWatcher.stop();

            // Unregister instance
            await this.instanceRegistry.unregister();

            this.isStarted = false;
            this.currentState = null;
            this.activeInstances = 0;
            this.localHistoryRevision = 0;
            this.highestSharedVersion = 0;
            this.emitStatusChanged();

            Logger.log('SyncManager stopped');
        } catch (error) {
            Logger.error('Error stopping SyncManager:', error);
        }
    }

    /**
     * Serialize one task on a chain. The task's own promise still rejects so
     * the caller observes the failure, while the chain tail swallows it so
     * the next queued task still runs.
     */
    private enqueue<T>(queueField: 'transitionQueue' | 'deliveryQueue', task: () => Promise<T>): Promise<T> {
        const run = this[queueField].then(task, task);
        this[queueField] = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * Notify other instances of a state change.
     *
     * Publications run inside the transition section, one at a time
     * interleaved with adoptions, so a snapshot is judged against the
     * local-history fence at publish time — not at call time (#108).
     *
     * @param state The new proxy state
     */
    async notifyChange(state: ProxyState): Promise<void> {
        if (!this.isStarted || !this.configManager.isSyncEnabled()) {
            return;
        }

        await this.enqueue('transitionQueue', () => this.publishSnapshot(state));
    }

    /**
     * A snapshot publication is stale only when its revision is below the
     * highest local revision this window already published or adopted. The
     * shared file's revision and the last seen remote revision are other
     * windows' counters and are never compared (#108).
     */
    private async publishSnapshot(state: ProxyState): Promise<void> {
        const snapshotRevision = stateRevision(state);
        if (snapshotRevision > 0 && snapshotRevision < this.localHistoryRevision) {
            Logger.warn(
                `Discarding stale sync publication (snapshot rev ${snapshotRevision}, local history rev ${this.localHistoryRevision}).`
            );
            return;
        }

        await this.publishState(state, snapshotRevision);
    }

    /**
     * Write one state to the shared file through the version compare-and-swap.
     *
     * `snapshotRevision` marks a snapshot publication: on success it raises
     * the local-history fence and the shared-version watermark. A reassert
     * (`undefined`) writes neither: it republishes the state this window
     * already holds, not a new local snapshot, so it moves neither the fence
     * nor the watermark (#108).
     */
    private async publishState(state: ProxyState, snapshotRevision?: number, retryPending?: PendingPublish): Promise<void> {
        try {
            const instanceId = this.instanceRegistry.getInstanceId();
            if (!instanceId) {
                return;
            }

            const onDisk = await this.sharedStateFile.read();
            const expectedVersion = onDisk?.version;
            const version = Math.max(
                onDisk?.version ?? 0,
                this.currentState?.version ?? 0
            ) + 1;
            const now = Date.now();
            // The pending token is window-local: the published state must not
            // carry this window's apply ownership to its peers (#135).
            const sharedProxyState = stripConvergencePendingToken(sanitizeProxyStateForPersistence(state));

            const sharedState: SharedState = {
                version,
                lastModified: now,
                lastModifiedBy: instanceId,
                proxyState: sharedProxyState,
                testResult: sharedProxyState.lastTestResult
            };

            const cas = this.sharedStateFile.compareAndSwap
                ? await this.sharedStateFile.compareAndSwap(expectedVersion, sharedState)
                : 'written';
            if (cas === 'stale') {
                Logger.warn(
                    `Discarding stale sync publication (CAS expected version ${String(expectedVersion)}).`
                );
                // A stale CAS means another window's write landed between the
                // read and the compare-and-swap: the loser is superseded by
                // what it lost to. The pending record must still reach a
                // terminal state — resolve it instead of leaving a pending
                // publish with no retry scheduled, which would skip every
                // remote adoption forever, and re-deliver the shared state so
                // the skipped remote versions are adopted (#137). A fresh
                // snapshot resolves only a pending record no newer than its
                // own commit: a record newer than it belongs to a later commit
                // and keeps its own retries (#145).
                const pendingSuperseded = retryPending
                    ? this.pendingPublish === retryPending
                    : snapshotRevision !== undefined &&
                        this.pendingPublish !== null &&
                        this.pendingPublish.snapshotRevision <= snapshotRevision;
                if (pendingSuperseded) {
                    this.clearPendingPublishRetry();
                    void this.redeliverSharedState();
                }
                return;
            }

            if (!this.sharedStateFile.compareAndSwap) {
                await this.sharedStateFile.write(sharedState);
            }

            this.currentState = {
                state: sharedProxyState,
                timestamp: now,
                instanceId,
                version
            };
            if (snapshotRevision !== undefined) {
                this.localHistoryRevision = Math.max(this.localHistoryRevision, snapshotRevision);
                this.highestSharedVersion = Math.max(this.highestSharedVersion, version);
                // A delivered snapshot satisfies (or supersedes) the pending
                // commit — there is nothing left to retry (#137).
                this.clearPendingPublishRetry();
            }
            this.lastSyncTime = now;
            this.lastError = null;
            this.emitStatusChanged();

            Logger.log(`State change propagated (version ${version})`);
        } catch (error) {
            Logger.error('Failed to notify state change:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            if (retryPending) {
                this.queuePublishRetry();
            } else if (snapshotRevision !== undefined && this.isStarted) {
                this.schedulePublishRetry(state, snapshotRevision);
            }
        }
    }

    /**
     * The commit was decided; only its delivery failed. Keep it pending so
     * the retries can land it: raise the local-history fence now (a stale
     * snapshot must not publish over the pending commit), and while it is
     * pending remote adoptions are skipped so an older remote state cannot
     * silently overwrite it (#137).
     */
    private schedulePublishRetry(state: ProxyState, snapshotRevision: number): void {
        this.clearPendingPublishRetry();
        this.pendingPublish = {
            state,
            snapshotRevision,
            attempts: 0,
            generation: ++this.publishRetrySeq
        };
        this.localHistoryRevision = Math.max(this.localHistoryRevision, snapshotRevision);
        this.queuePublishRetry();
    }

    private queuePublishRetry(): void {
        const pending = this.pendingPublish;
        if (!pending) {
            return;
        }
        if (pending.attempts >= this.publishRetryDelaysMs.length) {
            this.exhaustPendingPublish();
            return;
        }

        const jitter = 1 - PUBLISH_RETRY_JITTER + 2 * PUBLISH_RETRY_JITTER * this.publishRetryRandom();
        const generation = pending.generation;
        this.publishRetryTimer = setTimeout(() => {
            this.publishRetryTimer = null;
            void this.enqueue('transitionQueue', async () => {
                const current = this.pendingPublish;
                if (!current || current.generation !== generation) {
                    // A newer commit or a stop superseded this retry (#137).
                    return;
                }
                if (!this.isStarted || !this.configManager.isSyncEnabled()) {
                    this.clearPendingPublishRetry();
                    return;
                }
                current.attempts += 1;
                await this.publishState(current.state, current.snapshotRevision, current);
            });
        }, this.publishRetryDelaysMs[pending.attempts] * jitter);
        this.publishRetryTimer.unref?.();
    }

    private exhaustPendingPublish(): void {
        const attempts = this.pendingPublish?.attempts ?? 0;
        this.pendingPublish = null;
        Logger.error(
            `Giving up republishing the local commit after ${attempts} retries; ` +
            're-adopting the current shared state'
        );
        void this.redeliverSharedState();
    }

    /**
     * Re-deliver the shared file's current state through the remoteChange
     * channel. Used when a pending commit's retries gave out: the remote
     * deliveries skipped while the commit was unpublished are re-examined so
     * the window converges instead of staying diverged (#137).
     */
    private async redeliverSharedState(): Promise<void> {
        try {
            if (!this.isStarted || !this.configManager.isSyncEnabled()) {
                return;
            }
            const sharedState = await this.sharedStateFile.read();
            if (sharedState) {
                // Forced: the on-disk version may equal the watermark —
                // nothing else wrote while every publish retry failed, and
                // the normal version check would suppress exactly the
                // re-delivery the exhaustion path needs (#137).
                this.emit('remoteChange', { state: sharedState.proxyState, version: sharedState.version, force: true });
            }
        } catch (error) {
            Logger.warn('Failed to re-deliver the shared state:', error);
        }
    }

    private clearPendingPublishRetry(): void {
        if (this.publishRetryTimer) {
            clearTimeout(this.publishRetryTimer);
            this.publishRetryTimer = null;
        }
        this.pendingPublish = null;
    }

    /**
     * Absorb one remote delivery.
     *
     * The adoption (version check -> save -> fence/watermark update) is a
     * transition-section task enqueued here, synchronously at the call — the
     * listener calls this inside emit(), so adoptions run in emission order,
     * interleaved with this window's own publications. A delivery therefore
     * moves the fence and the watermark before its convergence starts: a
     * background result that captured its generation earlier sees the moved
     * revision and is discarded instead of being published over the delivery
     * (#108).
     *
     * The convergence (`absorb`, i.e. applyRemoteSyncState's gate -> apply ->
     * monitoring -> status) runs on the delivery chain, one delivery at a
     * time in emission order, and awaits the outcome of its own adoption
     * instead of starting it. Because the adoption left the section before
     * the delivery task runs, an apply that awaits a publication (monitoring
     * start runs the detection path, which publishes) cannot deadlock the
     * section.
     *
     * `saveRemoteState` is the caller's local persist; it returns the local
     * revision after the save. `adopted` inside `absorb` resolves to whether
     * this delivery's adoption — decided at emission — saved the state
     * (false when the delivery was superseded; nothing was saved).
     */
    async absorbRemoteChange(
        delivery: RemoteSyncDelivery,
        saveRemoteState: (state: ProxyState) => Promise<number>,
        absorb: (adopted: () => Promise<boolean>) => Promise<unknown>
    ): Promise<void> {
        const adoption: Promise<boolean> = this.enqueue('transitionQueue', async () => {
            // A forced delivery exists to re-adopt the version the watermark
            // already holds, so it bypasses equality only — a version below
            // the watermark is still older than what this window has and must
            // never overwrite it (#145).
            const supersededByWatermark = delivery.force
                ? delivery.version < this.highestSharedVersion
                : delivery.version <= this.highestSharedVersion;
            if (supersededByWatermark) {
                Logger.warn(
                    `Skipping superseded remote delivery ` +
                    `(version ${delivery.version}, highest ${this.highestSharedVersion}).`
                );
                return false;
            }
            if (this.pendingPublish) {
                // A remote write must not silently overwrite a decided local
                // commit whose delivery to the shared file is still being
                // retried: this window's local state IS that pending commit,
                // and saving the remote state would diverge it from what the
                // retry is about to publish (#137). The commit is republished
                // on top of the delivery's version, or the current shared
                // state is re-delivered when the retries give out.
                Logger.warn(
                    `Skipping remote delivery (version ${delivery.version}): ` +
                    `local commit (rev ${this.pendingPublish.snapshotRevision}) is still unpublished`
                );
                return false;
            }
            try {
                // The pending token names the publishing window's apply; an
                // adoption must not import an ownership this window does not
                // hold (#135).
                const localRevision = await saveRemoteState(stripConvergencePendingToken({ ...delivery.state }));
                this.localHistoryRevision = Math.max(this.localHistoryRevision, localRevision);
                this.highestSharedVersion = Math.max(this.highestSharedVersion, delivery.version);
                return true;
            } catch (error) {
                Logger.error('Failed to adopt remote sync delivery:', error);
                if (this.currentState?.version === delivery.version) {
                    // The cache claims a shared state this adoption just
                    // failed to deliver — the runtime-enable path caches it
                    // before the adoption runs (#137). Drop it so the next
                    // reconcile re-emits the delivery instead of judging
                    // the window already synced.
                    this.currentState = null;
                }
                if (delivery.force) {
                    // A forced delivery exists because the watermark already
                    // holds its version; a re-emission only works when the
                    // watermark lets the same version through again.
                    this.highestSharedVersion = Math.min(this.highestSharedVersion, delivery.version - 1);
                }
                // The recovery above only helps if a reconcile re-examines
                // the file — but nothing was written, so its signature still
                // matches the last observed one and the periodic poll would
                // skip the reconcile forever (#137). Invalidate it so the
                // next scheduled poll re-emits this delivery.
                this.lastObservedFileSignature = null;
                throw error;
            }
        });
        // The adoption may sit rejected while its delivery waits on the
        // delivery chain; this sink keeps that wait from being reported as an
        // unhandled rejection. The delivery task still observes the rejection
        // through `adoption` itself.
        adoption.catch(() => undefined);

        let adoptedCalled = false;
        const adopted = (): Promise<boolean> => {
            if (adoptedCalled) {
                return Promise.reject(new Error('adopted() called twice for one remote sync delivery'));
            }
            adoptedCalled = true;
            return adoption;
        };
        await this.enqueue('deliveryQueue', () => absorb(adopted));
    }

    /**
     * Manually trigger a sync
     */
    async triggerSync(): Promise<SyncResult> {
        if (this.isSyncing || this.remoteChangeInProgress) {
            return {
                success: false,
                instancesNotified: 0,
                conflictsResolved: 0,
                error: 'Sync already in progress'
            };
        }

        this.isSyncing = true;
        this.emitStatusChanged();

        try {
            const reconciliation = await this.reconcileWithSharedFile();

            // Get active instances
            const instances = await this.instanceRegistry.getActiveInstances();
            this.activeInstances = instances.length;

            // Clean up zombies
            const instancesCleaned = await this.instanceRegistry.cleanup();

            this.lastSyncTime = Date.now();
            // A pending commit keeps its publish error until the retry lands
            // or gives out (#137).
            if (!this.pendingPublish) {
                this.lastError = null;
            }

            return {
                success: true,
                instancesNotified: instances.length,
                conflictsResolved: reconciliation.conflictsResolved,
                instancesCleaned
            };
        } catch (error) {
            Logger.error('Sync failed:', error);
            this.lastError = error instanceof Error ? error.message : String(error);

            return {
                success: false,
                instancesNotified: 0,
                conflictsResolved: 0,
                instancesCleaned: 0,
                error: this.lastError
            };
        } finally {
            this.isSyncing = false;
            this.emitStatusChanged();
        }
    }

    /**
     * Get current sync status
     */
    getSyncStatus(): SyncStatus {
        return {
            enabled: this.isStarted,
            activeInstances: this.activeInstances,
            lastSyncTime: this.lastSyncTime,
            lastError: this.lastError,
            isSyncing: this.isSyncing
        };
    }

    /**
     * Get the last shared proxy state loaded or written by this manager.
     *
     * Used during extension startup to apply an existing shared state before
     * publishing this instance's local state.
     */
    getCurrentSharedState(): ProxyState | null {
        return this.currentState ? { ...this.currentState.state } : null;
    }

    /**
     * Check if sync is enabled
     */
    isEnabled(): boolean {
        return this.isStarted && this.configManager.isSyncEnabled();
    }

    /**
     * Periodic safety-net poll for remote changes.
     *
     * The file watcher is the primary detection path; this poll only has to
     * catch changes the OS never reported. Gating it on a stat() signature keeps
     * the common (nothing changed) tick down to a single syscall instead of a
     * full read + JSON.parse + sanitize of the shared state file.
     */
    private pollRemoteChange(): void {
        const signature = this.readChangeSignature();
        if (signature !== null && signature === this.lastObservedFileSignature) {
            return;
        }

        void this.handleRemoteChange();
    }

    /**
     * Read the shared state file revision signature, or null when the backing
     * implementation does not support it (in which case polling is ungated).
     */
    private readChangeSignature(): string | null {
        return this.sharedStateFile.getChangeSignature?.() ?? null;
    }

    /**
     * Handle remote state change detected by file watcher
     */
    private async handleRemoteChange(): Promise<void> {
        if (!this.isStarted || this.isSyncing || this.remoteChangeInProgress) {
            return;
        }

        this.remoteChangeInProgress = true;
        try {
            // Sample the revision before reading so a write that lands mid-read
            // is re-examined on the next poll instead of being skipped.
            this.lastObservedFileSignature = this.readChangeSignature();
            await this.reconcileWithSharedFile();
        } catch (error) {
            Logger.error('Failed to handle remote change:', error);
            this.lastError = error instanceof Error ? error.message : String(error);
            this.emitStatusChanged();
            this.emit('syncError', error);
        } finally {
            this.remoteChangeInProgress = false;
        }
    }

    /**
     * Load initial state from shared file
     */
    private async loadInitialState(): Promise<SharedState | null> {
        try {
            const sharedState = await this.sharedStateFile.read();
            if (sharedState) {
                this.currentState = {
                    state: sharedState.proxyState,
                    timestamp: sharedState.lastModified,
                    instanceId: sharedState.lastModifiedBy,
                    version: sharedState.version
                };

                Logger.log('Loaded initial state from shared file');
                return sharedState;
            }
        } catch (error) {
            Logger.warn('Failed to load initial state:', error);
            // Not critical - we'll create state on first change
        }
        return null;
    }

    /**
     * Handle configuration change
     */
    private handleConfigChange(key: string, value: unknown): void {
        handleSyncConfigChange(key, value, {
            isStarted: () => this.isStarted,
            // A runtime enable adopts the already-published shared state the
            // same way startup does, by delivering it as a remote change (#137).
            start: () => void this.start(true),
            stop: () => void this.stop(),
            reschedulePeriodicSync: () => this.timers.reschedulePeriodicSync()
        });
    }

    private async reconcileWithSharedFile(): Promise<{ conflictsResolved: number }> {
        const sharedState = await this.sharedStateFile.read();
        const localInstanceId = this.instanceRegistry.getInstanceId();
        const result = reconcileSharedState(
            sharedState,
            localInstanceId,
            this.currentState,
            this.conflictResolver
        );

        this.currentState = result.currentState;

        if (result.remoteChange) {
            this.emit('remoteChange', result.remoteChange);
        }

        if (result.conflictDetails) {
            this.emit('conflictResolved', result.conflictDetails);
        }

        if (result.conflictLog) {
            Logger.log(result.conflictLog);
        }

        if (result.reassertLocalState) {
            // A reassert republishes the state this window already holds
            // through the same transition section, but it is not a new local
            // snapshot: the snapshot fence does not apply, and it moves
            // neither the fence nor the version watermark (#108).
            // While a local commit is still unpublished its retry republishes
            // the newer state instead, so the reassert is skipped (#137).
            if (!this.pendingPublish && this.isStarted && this.configManager.isSyncEnabled()) {
                const reasserted = result.reassertLocalState;
                await this.enqueue('transitionQueue', () => this.publishState(reasserted));
            }
            return { conflictsResolved: result.conflictsResolved };
        }

        // A pending commit keeps its publish error until the retry lands or
        // gives out (#137).
        if (result.markSynced && !this.pendingPublish) {
            this.lastSyncTime = Date.now();
            this.lastError = null;
            this.emitStatusChanged();
        }

        return { conflictsResolved: result.conflictsResolved };
    }

    /**
     * Emit status changed event
     */
    private emitStatusChanged(): void {
        this.emit('syncStateChanged', this.getSyncStatus());
    }

    private async refreshActiveInstances(): Promise<void> {
        try {
            const previous = this.activeInstances;
            const instances = await this.instanceRegistry.getActiveInstances();
            this.activeInstances = instances.length;
            if (this.isStarted && this.activeInstances !== previous) {
                this.emitStatusChanged();
            }
        } catch (error) {
            Logger.warn('Failed to refresh active instances:', error);
            // Keep the last known value (defaults to 0).
        }
    }

}
