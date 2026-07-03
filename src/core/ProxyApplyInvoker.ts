import { InitializerContext } from './ExtensionInitializerTypes';
import { ProxyApplyOptions } from './ProxyApplierTypes';

export async function applyProxyThroughContext(
    context: InitializerContext,
    url: string,
    enabled: boolean,
    options?: ProxyApplyOptions
): Promise<boolean> {
    if (context.applyProxySettings) {
        return await context.applyProxySettings(url, enabled, options);
    }

    return await context.proxyApplier.applyProxy(url, enabled, options);
}
