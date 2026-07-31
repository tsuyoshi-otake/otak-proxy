/**
 * External configuration commands can spend several seconds starting on a
 * busy Windows host. Keep the deadline bounded while allowing normal process
 * startup and antivirus/file-system contention to settle.
 */
export const CONFIG_COMMAND_TIMEOUT_MS = 15_000;

/**
 * A Git write can contain two sequential commands (http.proxy and
 * https.proxy). The mutex must outlive the complete write operation, not just
 * one command, or a second window can report lock contention while the first
 * window is still within its valid command deadlines.
 */
export const GIT_CONFIG_MUTEX_TIMEOUT_MS = CONFIG_COMMAND_TIMEOUT_MS * 2 + 5_000;

/**
 * A live Git write must not be considered stale while it is still within the
 * mutex wait budget. The extra margin covers retry delays and filesystem work.
 */
export const GIT_CONFIG_MUTEX_STALE_MS = GIT_CONFIG_MUTEX_TIMEOUT_MS + 10_000;
