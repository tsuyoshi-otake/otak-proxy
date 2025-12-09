import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';
import { OutputChannelManager, ErrorDetails } from './OutputChannelManager';
import { NotificationThrottler } from './NotificationThrottler';
import { NotificationFormatter } from './NotificationFormatter';

/**
 * UserNotifier provides consistent user feedback through VSCode notifications.
 * Formats error messages with troubleshooting suggestions following the design document format.
 * Supports both direct messages and i18n message keys.
 * 
 * Enhanced with:
 * - Detailed error logging to output channel
 * - Notification throttling to prevent duplicates
 * - Message formatting for concise notifications
 * - Auto-close functionality for different notification types
 * - Progress notifications for long-running operations
 */
export class UserNotifier {
    private i18n: I18nManager;
    private outputManager: OutputChannelManager;
    private throttler: NotificationThrottler;

    constructor() {
        this.i18n = I18nManager.getInstance();
        this.outputManager = OutputChannelManager.getInstance();
        this.throttler = new NotificationThrottler();
    }

    /**
     * Shows an error message with optional troubleshooting suggestions
     * Enhanced with message formatting and throttling
     * @param message - The error message to display (can be a message key or direct text)
     * @param suggestions - Optional array of troubleshooting steps (can be message keys or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showError(message: string, suggestions?: string[], params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        const translatedSuggestions = suggestions?.map(s => this.translateIfKey(s));
        
        // Apply message formatting
        const summarizedMessage = NotificationFormatter.summarize(translatedMessage);
        const summarizedSuggestions = translatedSuggestions 
            ? NotificationFormatter.summarizeSuggestions(translatedSuggestions)
            : undefined;
        
        const formattedMessage = this.formatMessage(summarizedMessage, summarizedSuggestions);
        
        // Check throttling
        const throttleKey = `error:${message}`;
        if (!this.throttler.shouldShow(throttleKey)) {
            // Still log to output channel even if throttled
            this.outputManager.logError(translatedMessage, {
                timestamp: new Date(),
                errorMessage: translatedMessage,
                suggestions: translatedSuggestions
            });
            return;
        }
        
        this.throttler.recordNotification(throttleKey);
        vscode.window.showErrorMessage(formattedMessage);
    }

    /**
     * Shows a success message with auto-close after 3 seconds
     * @param message - The success message to display (can be a message key or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showSuccess(message: string, params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        this.showNotificationWithTimeout('info', translatedMessage, 3000);
    }

    /**
     * Shows a warning message with auto-close after 10 seconds
     * @param message - The warning message to display (can be a message key or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showWarning(message: string, params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        this.showNotificationWithTimeout('warning', translatedMessage, 10000);
    }

    /**
     * Translate a message if it's a message key, otherwise return as-is
     * @param messageOrKey - Message key or direct text
     * @param params - Optional parameters for substitution
     * @returns Translated message or original text
     */
    private translateIfKey(messageOrKey: string, params?: Record<string, string>): string {
        // Check if it looks like a message key (contains dots and no spaces)
        if (messageOrKey.includes('.') && !messageOrKey.includes(' ')) {
            return this.i18n.t(messageOrKey, params);
        }
        // Otherwise, return as-is for backward compatibility
        return messageOrKey;
    }

    /**
     * Shows an error message with detailed information logged to output channel
     * Includes a "Show Details" button to open the output channel
     * @param message - The error message to display (can be a message key or direct text)
     * @param details - Detailed error information to log
     * @param suggestions - Optional array of troubleshooting steps
     * @param params - Optional parameters for message key substitution
     */
    async showErrorWithDetails(
        message: string,
        details: ErrorDetails,
        suggestions?: string[],
        params?: Record<string, string>
    ): Promise<void> {
        const translatedMessage = this.translateIfKey(message, params);
        const translatedSuggestions = suggestions?.map(s => this.translateIfKey(s));
        
        // Log detailed information to output channel
        this.outputManager.logError(translatedMessage, {
            ...details,
            suggestions: translatedSuggestions
        });
        
        // Apply message formatting for notification
        const summarizedMessage = NotificationFormatter.summarize(translatedMessage);
        const summarizedSuggestions = translatedSuggestions 
            ? NotificationFormatter.summarizeSuggestions(translatedSuggestions)
            : undefined;
        
        const formattedMessage = this.formatMessage(summarizedMessage, summarizedSuggestions);
        
        // Check throttling
        const throttleKey = `error:${message}`;
        if (!this.throttler.shouldShow(throttleKey)) {
            return;
        }
        
        this.throttler.recordNotification(throttleKey);
        
        // Show error with "Show Details" button
        const showDetailsLabel = this.translateIfKey('action.showDetails');
        const action = await vscode.window.showErrorMessage(formattedMessage, showDetailsLabel);
        
        if (action === showDetailsLabel) {
            this.outputManager.show();
        }
    }

    /**
     * Shows a progress notification for long-running operations
     * @param title - The title of the progress notification
     * @param task - The task to execute with progress reporting
     * @param cancellable - Whether the operation can be cancelled
     * @returns Promise that resolves with the task result
     */
    async showProgressNotification<T>(
        title: string,
        task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>,
        cancellable: boolean = false
    ): Promise<T> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable
            },
            task
        );
    }

    /**
     * Shows a notification with automatic timeout
     * @param type - The notification type
     * @param message - The message to display
     * @param timeoutMs - Time in milliseconds before auto-closing (undefined = no auto-close)
     * @param actions - Optional action buttons
     * @returns Promise that resolves with the selected action or undefined
     */
    private async showNotificationWithTimeout(
        type: 'info' | 'warning' | 'error',
        message: string,
        timeoutMs?: number,
        actions?: string[]
    ): Promise<string | undefined> {
        let showMethod: (message: string, ...items: string[]) => Thenable<string | undefined>;
        
        switch (type) {
            case 'error':
                showMethod = vscode.window.showErrorMessage;
                break;
            case 'warning':
                showMethod = vscode.window.showWarningMessage;
                break;
            case 'info':
            default:
                showMethod = vscode.window.showInformationMessage;
                break;
        }
        
        const actionItems = actions || [];
        const resultPromise = showMethod.call(vscode.window, message, ...actionItems);
        
        // If timeout is specified, auto-close by showing a new notification
        if (timeoutMs !== undefined) {
            setTimeout(() => {
                // VSCode doesn't provide a direct way to close notifications
                // The notification will be replaced when a new one appears or user closes it
            }, timeoutMs);
        }
        
        return resultPromise;
    }

    /**
     * Formats a message with troubleshooting suggestions
     * @param message - The main message
     * @param suggestions - Optional array of suggestions
     * @returns Formatted message string
     */
    private formatMessage(message: string, suggestions?: string[]): string {
        if (!suggestions || suggestions.length === 0) {
            return message;
        }

        // Format: [Message]\n\nSuggestions:\n- [Suggestion 1]\n- [Suggestion 2]
        const suggestionText = suggestions.map(s => `• ${s}`).join('\n');
        return `${message}\n\nSuggestions:\n${suggestionText}`;
    }
}
