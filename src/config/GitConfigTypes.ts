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
    /**
     * Keys that still hold the value this call wrote after a failed multi-key
     * set. Empty/absent when compensation cleared or an external writer changed them.
     */
    residualKeys?: readonly string[];
}
