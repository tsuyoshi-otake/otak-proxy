import { Logger } from '../utils/Logger';

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
    constructor(private envCollection: any) {}

    async setProxy(url: string): Promise<OperationResult> {
        try {
            if (!this.envCollection || typeof this.envCollection.replace !== 'function') {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy set');
                return { success: true };
            }

            const vars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
            for (const v of vars) {
                this.envCollection.replace(v, url);
            }

            return { success: true };
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            Logger.error('Failed to set terminal environment proxy:', error);
            return { success: false, error: errorMessage, errorType: 'UNKNOWN' };
        }
    }

    async unsetProxy(): Promise<OperationResult> {
        try {
            if (!this.envCollection || typeof this.envCollection.delete !== 'function') {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy unset');
                return { success: true };
            }

            const vars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
            for (const v of vars) {
                this.envCollection.delete(v);
            }

            return { success: true };
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            Logger.error('Failed to unset terminal environment proxy:', error);
            return { success: false, error: errorMessage, errorType: 'UNKNOWN' };
        }
    }
}

