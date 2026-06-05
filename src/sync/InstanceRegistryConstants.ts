/**
 * Current schema version.
 */
export const INSTANCE_REGISTRY_SCHEMA_VERSION = 1;

/**
 * Sync directory name.
 */
export const SYNC_DIR_NAME = 'otak-proxy-sync';

/**
 * Lock file name.
 */
export const INSTANCE_LOCK_FILE_NAME = 'instances.lock';

/**
 * Heartbeat timeout in milliseconds (30 seconds).
 */
export const HEARTBEAT_TIMEOUT = 30000;

/**
 * Mutex acquisition timeout for updating the lock file.
 */
export const MUTEX_TIMEOUT_MS = 5000;

/**
 * If a mutex file is older than this, assume it is stale and remove it.
 */
export const MUTEX_STALE_MS = 30000;

/**
 * Delay between mutex acquisition attempts.
 */
export const MUTEX_RETRY_DELAY_MS = 25;
