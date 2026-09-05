export interface GitConfigOperationOptions {
    onStatus?: (messageKey: string) => void;
}

export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'LOCKED' | 'UNKNOWN';
    /**
     * Keys that still hold the value this call wrote after a failed multi-key
     * set. Empty/absent when compensation cleared or an external writer changed them.
     */
    residualKeys?: readonly string[];
}
