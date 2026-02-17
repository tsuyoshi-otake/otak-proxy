import { Logger } from '../utils/Logger';

type EnvCollectionReplaceLike = {
    replace(name: string, value: string): void;
};

type EnvCollectionDeleteLike = {
    delete(name: string): void;
};

const PROXY_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function canReplace(value: unknown): value is EnvCollectionReplaceLike {
    return isRecord(value) && typeof value.replace === 'function';
}

function canDelete(value: unknown): value is EnvCollectionDeleteLike {
    return isRecord(value) && typeof value.delete === 'function';
}

/**
 * Result of a terminal environment variable operation.
 */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_AVAILABLE' | 'UNKNOWN';
}

/**
 * Manages proxy-related environment variables for newly created VSCode integrated terminals.
 *
 * This uses ExtensionContext.environmentVariableCollection to inject:
 * - HTTP_PROXY / HTTPS_PROXY
 * - http_proxy / https_proxy
 *
 * NO_PROXY is intentionally left untouched unless a future config is added.
 */
export class TerminalEnvConfigManager {
    constructor(private readonly envCollection: unknown) {}

    async setProxy(url: string): Promise<OperationResult> {
        try {
            if (!canReplace(this.envCollection)) {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy set');
                return { success: true };
            }

            for (const v of PROXY_ENV_VARS) {
                this.envCollection.replace(v, url);
            }

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error('Failed to set terminal environment proxy:', error);
            return { success: false, error: errorMessage, errorType: 'UNKNOWN' };
        }
    }

    async unsetProxy(): Promise<OperationResult> {
        try {
            if (!canDelete(this.envCollection)) {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy unset');
                return { success: true };
            }

            for (const v of PROXY_ENV_VARS) {
                this.envCollection.delete(v);
            }

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error('Failed to unset terminal environment proxy:', error);
            return { success: false, error: errorMessage, errorType: 'UNKNOWN' };
        }
    }
}

