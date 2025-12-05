import * as vscode from 'vscode';

/**
 * UserNotifier provides consistent user feedback through VSCode notifications.
 * Formats error messages with troubleshooting suggestions following the design document format.
 */
export class UserNotifier {
    /**
     * Shows an error message with optional troubleshooting suggestions
     * @param message - The error message to display
     * @param suggestions - Optional array of troubleshooting steps
     */
    showError(message: string, suggestions?: string[]): void {
        const formattedMessage = this.formatMessage(message, suggestions);
        vscode.window.showErrorMessage(formattedMessage);
    }

    /**
     * Shows a success message
     * @param message - The success message to display
     */
    showSuccess(message: string): void {
        vscode.window.showInformationMessage(message);
    }

    /**
     * Shows a warning message
     * @param message - The warning message to display
     */
    showWarning(message: string): void {
        vscode.window.showWarningMessage(message);
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
