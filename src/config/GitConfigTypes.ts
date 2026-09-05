export interface GitConfigOperationOptions {
    onStatus?: (messageKey: string) => void;
    /**
     * When set, unset only removes these exact values (git --unset-all + value-pattern).
     * A key whose current value differs is left untouched.
     */
    expectedValues?: Readonly<Partial<Record<'http.proxy' | 'https.proxy', string>>>;
}

export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'LOCKED' | 'UNKNOWN';
    preservedKeys?: readonly string[];
}
