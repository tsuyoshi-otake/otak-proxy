import * as vscode from 'vscode';
import { I18nManager } from '../i18n/I18nManager';

/**
 * UserNotifier provides consistent user feedback through VSCode notifications.
 * Formats error messages with troubleshooting suggestions following the design document format.
 * Supports both direct messages and i18n message keys.
 */
export class UserNotifier {
    private i18n: I18nManager;

    constructor() {
        this.i18n = I18nManager.getInstance();
    }

    /**
     * Shows an error message with optional troubleshooting suggestions
     * @param message - The error message to display (can be a message key or direct text)
     * @param suggestions - Optional array of troubleshooting steps (can be message keys or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showError(message: string, suggestions?: string[], params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        const translatedSuggestions = suggestions?.map(s => this.translateIfKey(s));
        const formattedMessage = this.formatMessage(translatedMessage, translatedSuggestions);
        vscode.window.showErrorMessage(formattedMessage);
    }

    /**
     * Shows a success message
     * @param message - The success message to display (can be a message key or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showSuccess(message: string, params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        vscode.window.showInformationMessage(translatedMessage);
    }

    /**
     * Shows a warning message
     * @param message - The warning message to display (can be a message key or direct text)
     * @param params - Optional parameters for message key substitution
     */
    showWarning(message: string, params?: Record<string, string>): void {
        const translatedMessage = this.translateIfKey(message, params);
        vscode.window.showWarningMessage(translatedMessage);
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
