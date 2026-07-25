import { IInstanceRegistry } from './InstanceRegistry';
import { ISyncConfigManager } from './SyncConfigManager';
import { CLEANUP_INTERVAL, HEARTBEAT_INTERVAL } from './SyncTiming';

export class SyncManagerTimers {
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private cleanupTimer: NodeJS.Timeout | null = null;
    private syncTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly instanceRegistry: IInstanceRegistry,
        private readonly configManager: ISyncConfigManager,
        private readonly onRemotePoll: () => void,
        private readonly onRefreshInstances: () => void
    ) {}

    startLifecycleTimers(): void {
        this.heartbeatTimer = setInterval(() => {
            // The instance list only changes when a window opens or closes, so
            // refreshing it on the heartbeat (which already touches the registry
            // file) is enough. Doing it on every sync tick re-read and re-parsed
            // the registry up to once per second for no observable benefit.
            void Promise.resolve(this.instanceRegistry.updateHeartbeat())
                .then(() => this.onRefreshInstances())
                .catch(() => this.onRefreshInstances());
        }, HEARTBEAT_INTERVAL);

        this.cleanupTimer = setInterval(() => {
            this.instanceRegistry.cleanup();
        }, CLEANUP_INTERVAL);
    }

    stopAll(): void {
        this.stopHeartbeatTimer();
        this.stopCleanupTimer();
        this.stopPeriodicSync();
    }

    reschedulePeriodicSync(): void {
        this.stopPeriodicSync();

        const intervalMs = this.configManager.getSyncInterval();
        this.syncTimer = setInterval(() => {
            this.onRemotePoll();
        }, intervalMs);
    }

    stopPeriodicSync(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    private stopHeartbeatTimer(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private stopCleanupTimer(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
}
