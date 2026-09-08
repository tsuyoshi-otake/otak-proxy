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
        try {
            if (!fs.existsSync(this.lockFilePath)) {
                return this.createEmptyLockFile();
            }

            const content = fs.readFileSync(this.lockFilePath, 'utf-8');
            if (!content || content.trim() === '') {
                return this.createEmptyLockFile();
            }

            return JSON.parse(content) as InstancesLockFile;
        } catch (error) {
            Logger.warn('Failed to read lock file, creating new one:', error);
            return this.createEmptyLockFile();
        }
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
