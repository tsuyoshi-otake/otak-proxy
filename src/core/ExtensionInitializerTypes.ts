import * as vscode from 'vscode';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { UserNotifier } from '../errors/UserNotifier';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { InputSanitizer } from '../validation/InputSanitizer';
import { ProxyApplier } from './ProxyApplier';
import { ProxyStateManager } from './ProxyStateManager';
import { ProxyState } from './types';

/**
 * Context for extension initialization.
 */
export interface InitializerContext {
    extensionContext: vscode.ExtensionContext;
    proxyStateManager: ProxyStateManager;
    proxyApplier: ProxyApplier;
    systemProxyDetector: SystemProxyDetector;
    userNotifier: UserNotifier;
    sanitizer: InputSanitizer;
    proxyChangeLogger: ProxyChangeLogger;
    updateStatusBar?: (state: ProxyState) => void;
}
