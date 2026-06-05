/**
 * Information about a registered instance.
 */
export interface InstanceInfo {
    /** Unique instance identifier (UUID) */
    id: string;
    /** Process ID */
    pid: number;
    /** VSCode window ID */
    windowId: string;
    /** Registration timestamp (Unix ms) */
    registeredAt: number;
    /** Last heartbeat timestamp (Unix ms) */
    lastHeartbeat: number;
    /** Extension version */
    extensionVersion: string;
}

/**
 * Interface for InstanceRegistry as defined in design.md.
 */
export interface IInstanceRegistry {
    /**
     * Register the current instance.
     * @returns True if registration succeeded
     */
    register(): Promise<boolean>;

    /**
     * Unregister the current instance.
     */
    unregister(): Promise<void>;

    /**
     * Get list of active instances.
     */
    getActiveInstances(): Promise<InstanceInfo[]>;

    /**
     * Check if other instances exist.
     */
    hasOtherInstances(): Promise<boolean>;

    /**
     * Cleanup inactive instances.
     * @returns Number of instances cleaned up
     */
    cleanup(): Promise<number>;

    /**
     * Update heartbeat for current instance.
     */
    updateHeartbeat(): Promise<void>;

    /**
     * Get the current instance ID.
     */
    getInstanceId(): string | null;
}

export interface InstancesLockFile {
    schemaVersion: number;
    instances: InstanceInfo[];
}
