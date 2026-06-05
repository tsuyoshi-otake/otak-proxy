export interface GitConfigOperationOptions {
    onStatus?: (messageKey: string) => void;
}

export interface OperationResult {
    success: boolean;
    error?: string;
    errorType?: 'NOT_INSTALLED' | 'NO_PERMISSION' | 'TIMEOUT' | 'LOCKED' | 'UNKNOWN';
}
