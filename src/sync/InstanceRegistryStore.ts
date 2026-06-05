import * as fs from 'fs';
import * as path from 'path';
import { getErrorCode } from '../utils/ErrorUtils';
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
    private readonly mutexFilePath: string;

    constructor(baseDir: string, private readonly pid: number) {
        this.syncDir = path.join(baseDir, SYNC_DIR_NAME);
        this.lockFilePath = path.join(this.syncDir, INSTANCE_LOCK_FILE_NAME);
        this.mutexFilePath = `${this.lockFilePath}.mutex`;
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
        const tempPath = `${this.lockFilePath}.${this.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
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
        await this.acquireMutex();

        try {
            return await fn();
        } finally {
            this.releaseMutex();
        }
    }

    private createEmptyLockFile(): InstancesLockFile {
        return { schemaVersion: INSTANCE_REGISTRY_SCHEMA_VERSION, instances: [] };
    }

    private async ensureSyncDir(): Promise<void> {
        if (!fs.existsSync(this.syncDir)) {
            fs.mkdirSync(this.syncDir, { recursive: true });
        }
    }

    private async acquireMutex(): Promise<void> {
        const start = Date.now();
        while (true) {
            try {
                const fd = fs.openSync(this.mutexFilePath, 'wx');
                fs.closeSync(fd);
                return;
            } catch (error) {
                if (getErrorCode(error) !== 'EEXIST') {
                    throw error;
                }

                this.removeStaleMutexIfNeeded();

                if (Date.now() - start > MUTEX_TIMEOUT_MS) {
                    throw new Error('Timed out acquiring instance registry mutex');
                }

                await new Promise(resolve => setTimeout(resolve, MUTEX_RETRY_DELAY_MS));
            }
        }
    }

    private removeStaleMutexIfNeeded(): void {
        try {
            const stat = fs.statSync(this.mutexFilePath);
            if (Date.now() - stat.mtimeMs > MUTEX_STALE_MS) {
                fs.unlinkSync(this.mutexFilePath);
            }
        } catch {
            // If stat/unlink fails, retry acquisition normally.
        }
    }

    private releaseMutex(): void {
        try {
            fs.unlinkSync(this.mutexFilePath);
        } catch {
            // ignore
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
