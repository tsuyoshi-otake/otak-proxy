export interface ProxyApplyOptions {
    silent?: boolean;
}

export interface ProxyConfigOperationResult {
    success: boolean;
    error?: string;
    errorType?: string;
}

export interface ProxyConfigManagerLike {
    setProxy(url: string): Promise<ProxyConfigOperationResult>;
    unsetProxy(): Promise<ProxyConfigOperationResult>;
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
