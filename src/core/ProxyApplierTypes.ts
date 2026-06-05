export interface ProxyApplyOptions {
    silent?: boolean;
    showProgress?: boolean;
}

export type ProxyConfigStatusReporter = (messageKey: string) => void;

export interface ProxyConfigOperationOptions {
    onStatus?: ProxyConfigStatusReporter;
}

interface ProxyConfigOperationResult {
    success: boolean;
    error?: string;
    errorType?: string;
}

interface ProxyConfigManagerLike {
    setProxy(url: string, options?: ProxyConfigOperationOptions): Promise<ProxyConfigOperationResult>;
    unsetProxy(options?: ProxyConfigOperationOptions): Promise<ProxyConfigOperationResult>;
}

export interface ProxyConfigTarget {
    name: string;
    manager: ProxyConfigManagerLike;
}

export interface ProxyConfigResults {
    gitSuccess: boolean;
    vscodeSuccess: boolean;
    npmSuccess: boolean;
    terminalEnvSuccess: boolean;
}
