import { Logger } from '../utils/Logger';

export interface SyncConfigChangeActions {
    isStarted: () => boolean;
    start: () => void;
    stop: () => void;
    reschedulePeriodicSync: () => void;
}

export function handleSyncConfigChange(
    key: string,
    value: unknown,
    actions: SyncConfigChangeActions
): void {
    if (key === 'syncEnabled') {
        handleSyncEnabledChange(value, actions);
        return;
    }

    if (key === 'syncInterval' && actions.isStarted()) {
        actions.reschedulePeriodicSync();
    }
}

function handleSyncEnabledChange(value: unknown, actions: SyncConfigChangeActions): void {
    if (value === false && actions.isStarted()) {
        Logger.log('Sync disabled via configuration, stopping...');
        actions.stop();
        return;
    }

    if (value === true && !actions.isStarted()) {
        Logger.log('Sync enabled via configuration, starting...');
        actions.start();
    }
}
