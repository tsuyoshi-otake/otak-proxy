import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorCode } from '../utils/ErrorUtils';
import { FileLease } from '../utils/FileLease';
import { Logger } from '../utils/Logger';
import {
    INSTANCE_LOCK_FILE_NAME,
    INSTANCE_REGISTRY_SCHEMA_VERSION,
    MUTEX_RETRY_DELAY_MS,
    MUTEX_STALE_MS,
    MUTEX_TIMEOUT_MS,
    REGISTRY_READ_RETRY_DELAYS_MS,
    SYNC_DIR_NAME
} from './InstanceRegistryConstants';
import { InstancesLockFile } from './InstanceRegistryTypes';

export class InstanceRegistryStore {
    private readonly syncDir: string;
    private readonly lockFilePath: string;
    private readonly mutex: FileLease;

    constructor(baseDir: string, private readonly pid: number) {
        this.syncDir = path.join(baseDir, SYNC_DIR_NAME);
        this.lockFilePath = path.join(this.syncDir, INSTANCE_LOCK_FILE_NAME);
        // Same lease primitive as the Git config mutex and the publish lock: an
        // anonymous lock file lets a slow holder delete its successor's lock (#73).
        this.mutex = new FileLease({
            lockPath: `${this.lockFilePath}.mutex`,
            leaseMs: MUTEX_STALE_MS,
            acquireTimeoutMs: MUTEX_TIMEOUT_MS,
            retryDelayMs: MUTEX_RETRY_DELAY_MS,
            name: 'instance registry mutex'
        });
    }

    async readLockFile(): Promise<InstancesLockFile> {
        if (!fs.existsSync(this.lockFilePath)) {
            return this.createEmptyLockFile();
        }

        let content: string;
        try {
            content = fs.readFileSync(this.lockFilePath, 'utf-8');
        } catch (error) {
            // A transient read failure (EBUSY from a scan holding the file, a
            // missing share) is not an empty registry: rethrow so callers do
            // not write a fake empty file over the real entries (#137). A
            // vanished file is a legitimately empty registry.
            if (getErrorCode(error) === 'ENOENT') {
                return this.createEmptyLockFile();
            }
            throw error;
        }

        if (!content || content.trim() === '') {
            return this.createEmptyLockFile();
        }

        try {
            return JSON.parse(content) as InstancesLockFile;
        } catch (error) {
            Logger.warn('Failed to parse lock file, creating new one:', error);
            return this.createEmptyLockFile();
        }
    }

    /**
     * Read the lock file with bounded retry for transient failures (#137): an
     * AV scan holding the file yields EBUSY/EPERM for a few hundred ms, so a
     * failed read is retried on REGISTRY_READ_RETRY_DELAYS_MS backoff with
     * jitter. Returns undefined when every attempt failed — callers must then
     * skip their write rather than risk wiping entries they could not read.
     */
    async readLockFileWithRetry(): Promise<InstancesLockFile | undefined> {
        let lastError: unknown;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.readLockFile();
            } catch (error) {
                lastError = error;
                const delay = REGISTRY_READ_RETRY_DELAYS_MS[attempt];
                if (delay === undefined) {
                    break;
                }
                const jitter = delay * 0.25 * (Math.random() * 2 - 1);
                await new Promise(resolve => setTimeout(resolve, delay + jitter));
            }
        }
        Logger.warn('Instance registry is unreadable after retries; skipping the write:', lastError);
        return undefined;
    }

    async writeLockFile(lockFile: InstancesLockFile): Promise<void> {
        const tempPath = `${this.lockFilePath}.${this.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        const content = JSON.stringify(lockFile, null, 2);

        fs.writeFileSync(tempPath, content, 'utf-8');

        try {
            const attempts = 5;
            for (let i = 0; i < attempts; i++) {
                try {
                    fs.renameSync(tempPath, this.lockFilePath);
                    return;
                } catch (error) {
                    const code = getErrorCode(error);
                    if ((code === 'EPERM' || code === 'EACCES') && i < attempts - 1) {
                        await new Promise(resolve => setTimeout(resolve, MUTEX_RETRY_DELAY_MS));
                        continue;
                    }
                    throw error;
                }
            }
        } finally {
            this.removeTempFileIfNeeded(tempPath);
        }
    }

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureSyncDir();
        return this.mutex.run(fn);
    }

    private createEmptyLockFile(): InstancesLockFile {
        return { schemaVersion: INSTANCE_REGISTRY_SCHEMA_VERSION, instances: [] };
    }

    private async ensureSyncDir(): Promise<void> {
        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }
    }

    private removeTempFileIfNeeded(tempPath: string): void {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // ignore
        }
    }
}
