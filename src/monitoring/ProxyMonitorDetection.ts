import { Logger } from '../utils/Logger';
import {
    ISystemProxyDetector,
    ProxyCheckTrigger,
    ProxyDetectionResult,
    ProxyMonitorConfig
} from './ProxyMonitorTypes';

interface ProxyDetectionRetryOptions {
    detector: ISystemProxyDetector;
    config: ProxyMonitorConfig;
    trigger: ProxyCheckTrigger;
    onAllRetriesFailed: (data: { error: string; trigger: ProxyCheckTrigger }) => void;
    sleep: (ms: number) => Promise<void>;
}

export async function detectProxyWithRetry(
    options: ProxyDetectionRetryOptions
): Promise<ProxyDetectionResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= options.config.maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const backoffMs = options.config.retryBackoffBase * Math.pow(2, attempt - 1) * 1000;
                await options.sleep(backoffMs);
                Logger.info(`Retry attempt ${attempt} after ${backoffMs}ms backoff`);
            }

            const detection = await detectProxy(options.detector);

            return {
                proxyUrl: detection.proxyUrl,
                source: detection.source as ProxyDetectionResult['source'],
                timestamp: Date.now(),
                success: true
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            Logger.warn(`Proxy detection attempt ${attempt + 1} failed: ${lastError}`);

            if (attempt === options.config.maxRetries) {
                options.onAllRetriesFailed({ error: lastError, trigger: options.trigger });
            }
        }
    }

    return {
        proxyUrl: null,
        source: null,
        timestamp: Date.now(),
        success: false,
        error: lastError
    };
}

async function detectProxy(
    detector: ISystemProxyDetector
): Promise<{ proxyUrl: string | null; source: string | null }> {
    if (detector.detectSystemProxyWithSource) {
        return await detector.detectSystemProxyWithSource();
    }

    const proxyUrl = await detector.detectSystemProxy();
    return { proxyUrl, source: null };
}
