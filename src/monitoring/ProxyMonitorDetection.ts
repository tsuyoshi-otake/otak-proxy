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
    /** Waits `ms`, or returns early once the check's lifecycle has ended. */
    sleep: (ms: number) => Promise<void>;
    /**
     * True once the lifecycle this check belongs to has ended (stop(), or a
     * newer start()). A cancelled check runs no further attempt and emits no
     * allRetriesFailed (#136).
     */
    isCancelled: () => boolean;
}

export async function detectProxyWithRetry(
    options: ProxyDetectionRetryOptions
): Promise<ProxyDetectionResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= options.config.maxRetries; attempt++) {
        // Before the sleep, so a stop() never leaves a backoff behind, and
        // after an attempt that was in flight when it arrived.
        if (options.isCancelled()) {
            return cancelledDetection();
        }

        try {
            if (attempt > 0) {
                const backoffMs = options.config.retryBackoffBase * Math.pow(2, attempt - 1) * 1000;
                await options.sleep(backoffMs);
                if (options.isCancelled()) {
                    return cancelledDetection();
                }
                Logger.info(`Retry attempt ${attempt} after ${backoffMs}ms backoff`);
            }

            const detection = await detectProxy(options.detector);

            return {
                proxyUrl: detection.proxyUrl,
                source: detection.source as ProxyDetectionResult['source'],
                kind: detection.kind,
                httpUrl: detection.httpUrl,
                httpsUrl: detection.httpsUrl,
                bypass: detection.bypass,
                capability: detection.capability,
                timestamp: Date.now(),
                success: true
            };
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            Logger.warn(`Proxy detection attempt ${attempt + 1} failed: ${lastError}`);

            if (attempt === options.config.maxRetries && !options.isCancelled()) {
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

/** What a check that was stopped mid-detection resolves to; the monitor discards it. */
function cancelledDetection(): ProxyDetectionResult {
    return {
        proxyUrl: null,
        source: null,
        timestamp: Date.now(),
        success: false,
        error: 'Detection cancelled: the monitor was stopped'
    };
}

async function detectProxy(
    detector: ISystemProxyDetector
): Promise<Pick<ProxyDetectionResult, 'proxyUrl' | 'source' | 'kind' | 'httpUrl' | 'httpsUrl' | 'bypass' | 'capability'>> {
    if (detector.detectSystemProxyWithSource) {
        const detection = await detector.detectSystemProxyWithSource();
        // A failed platform query is not "no proxy": fail the attempt so the
        // retry, backoff and keep-last-value handling apply.
        if (detection.kind === 'unknown') {
            throw new Error('System proxy detection failed: the platform query returned no usable answer');
        }
        return detection;
    }

    const proxyUrl = await detector.detectSystemProxy();
    return { proxyUrl, source: null };
}
