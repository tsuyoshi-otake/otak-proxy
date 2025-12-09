/**
 * @file Command Types
 * @description Type definitions for command execution context
 *
 * Requirements:
 * - 2.1: Provide context for command execution
 * - 2.3: Support error handling
 * - 2.4: Enable command independence
 */

import * as vscode from 'vscode';
import { ProxyMode, ProxyState } from '../core/types';

/**
 * Command execution context providing all dependencies needed by commands
 * This enables dependency injection for better testability
 */
export interface CommandContext {
    // Extension context
    extensionContext: vscode.ExtensionContext;

    // State management functions
    getProxyState: () => Promise<ProxyState>;
    saveProxyState: (state: ProxyState) => Promise<void>;
    getActiveProxyUrl: (state: ProxyState) => string;
    getNextMode: (currentMode: ProxyMode) => ProxyMode;

    // Proxy operations
    applyProxySettings: (url: string, enabled: boolean) => Promise<boolean>;
    updateStatusBar: (state: ProxyState) => void;
    checkAndUpdateSystemProxy: () => Promise<void>;
    startSystemProxyMonitoring: () => Promise<void>;

    // Notification utilities
    userNotifier: {
        showSuccess: (key: string, params?: Record<string, string>) => void;
        showWarning: (key: string, params?: Record<string, string>) => void;
        showError: (key: string, suggestions?: string[]) => void;
        showErrorWithDetails: (
            message: string,
            details: import('../errors/OutputChannelManager').ErrorDetails,
            suggestions?: string[],
            params?: Record<string, string>
        ) => Promise<void>;
        showProgressNotification: <T>(
            title: string,
            task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>,
            cancellable?: boolean
        ) => Promise<T>;
    };

    // Sanitization
    sanitizer: {
        maskPassword: (url: string) => string;
    };
}

/**
 * Result of command execution
 */
export interface CommandResult {
    success: boolean;
    error?: Error;
}
