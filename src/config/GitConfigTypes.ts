export type GitProxyKey = 'http.proxy' | 'https.proxy';

export interface GitConfigOperationOptions {
    onStatus?: (messageKey: string) => void;
    /**
     * Value-specific deletions for a key. Must never be interpreted as
     * permission to run value-less `--unset-all`.
     */
    exactValues?: Partial<Record<GitProxyKey, readonly string[]>>;
}

export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'LOCKED' | 'CONFIG_ERROR' | 'UNKNOWN';
}
