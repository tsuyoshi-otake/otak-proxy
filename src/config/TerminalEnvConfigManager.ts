import { Logger } from '../utils/Logger';

type EnvCollectionReplaceLike = {
    replace(name: string, value: string, options?: TerminalEnvMutationOptions): void;
};

type EnvCollectionDeleteLike = {
    delete(name: string): void;
};

type EnvCollectionMetadataLike = {
    persistent?: boolean;
    description?: string;
};

interface TerminalEnvMutationOptions {
    applyAtProcessCreation?: boolean;
}

export interface TerminalEnvConfigOptions {
    includeLowercase?: boolean;
    noProxy?: string;
    maskOnUnset?: boolean;
    description?: string;
}

const UPPER_PROXY_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY'] as const;
const LOWER_PROXY_ENV_VARS = ['http_proxy', 'https_proxy'] as const;
const UPPER_MASK_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;
const LOWER_MASK_ENV_VARS = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const;

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
    constructor(
        private readonly envCollection: unknown,
        private readonly options: TerminalEnvConfigOptions = {}
    ) {
        this.configureCollectionMetadata();
    }

    async setProxy(url: string): Promise<OperationResult> {
        try {
            if (!canReplace(this.envCollection)) {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy set');
                return { success: true };
            }

            for (const variable of this.getSetProxyVariables()) {
                this.envCollection.replace(variable, url, this.mutationOptions());
            }

            if (this.options.noProxy) {
                this.envCollection.replace('NO_PROXY', this.options.noProxy, this.mutationOptions());
                if (this.includeLowercase()) {
                    this.envCollection.replace('no_proxy', this.options.noProxy, this.mutationOptions());
                }
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
            if (this.options.maskOnUnset && canReplace(this.envCollection)) {
                for (const variable of this.getMaskVariables()) {
                    this.envCollection.replace(variable, '', this.mutationOptions());
                }
                return { success: true };
            }

            if (!canDelete(this.envCollection)) {
                Logger.warn('environmentVariableCollection is not available; skipping terminal env proxy unset');
                return { success: true };
            }

            for (const variable of this.getMaskVariables()) {
                this.envCollection.delete(variable);
            }

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error('Failed to unset terminal environment proxy:', error);
            return { success: false, error: errorMessage, errorType: 'UNKNOWN' };
        }
    }

    async cleanupStaleProxyMutators(): Promise<OperationResult> {
        return await this.unsetProxy();
    }

    private includeLowercase(): boolean {
        return this.options.includeLowercase ?? true;
    }

    private getSetProxyVariables(): string[] {
        const variables: string[] = [...UPPER_PROXY_ENV_VARS];
        if (this.includeLowercase()) {
            variables.push(...LOWER_PROXY_ENV_VARS);
        }
        return variables;
    }

    private getMaskVariables(): string[] {
        const variables: string[] = [...UPPER_MASK_ENV_VARS];
        if (this.includeLowercase()) {
            variables.push(...LOWER_MASK_ENV_VARS);
        }
        return variables;
    }

    private mutationOptions(): TerminalEnvMutationOptions {
        return { applyAtProcessCreation: true };
    }

    private configureCollectionMetadata(): void {
        if (!isRecord(this.envCollection)) {
            return;
        }

        const metadata = this.envCollection as EnvCollectionMetadataLike;
        if (typeof metadata.persistent === 'boolean') {
            metadata.persistent = true;
        }
        if ('description' in metadata) {
            metadata.description = this.options.description ?? 'Managed by otak-proxy for newly created terminals.';
        }
    }
}

