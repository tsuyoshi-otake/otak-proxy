import * as vscode from 'vscode';
import { InputSanitizer } from '../validation/InputSanitizer';

/**
 * ErrorDetails interface defines the structure for detailed error information
 */
export interface ErrorDetails {
    timestamp: Date;
    errorMessage: string;
    stackTrace?: string;
    attemptedUrls?: string[];
    suggestions?: string[];
    context?: Record<string, unknown>;
}

function safeStringify(value: unknown, indent: number | undefined = undefined): string {
    try {
        const json = JSON.stringify(value, null, indent);
        return json === undefined ? String(value) : json;
    } catch {
        return '[Unserializable]';
    }
}

/**
 * OutputChannelManager manages the output channel for detailed logging.
 * Implements singleton pattern to ensure a single output channel instance.
 * 
 * Requirements:
 * - 3.2: Log detailed information to output channel
 * - 3.3: Include timestamp, error message, stack trace, and attempted URLs
 * - 3.4: Record all attempted URLs and their errors
 */
export class OutputChannelManager {
    private static instance: OutputChannelManager;
    private outputChannel: vscode.OutputChannel;
    private sanitizer: InputSanitizer;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Otak Proxy');
        this.sanitizer = new InputSanitizer();
    }

    /**
     * Gets the singleton instance of OutputChannelManager
     * @returns The singleton instance
     */
    static getInstance(): OutputChannelManager {
        if (!OutputChannelManager.instance) {
            OutputChannelManager.instance = new OutputChannelManager();
        }
        return OutputChannelManager.instance;
    }

    /**
     * Logs error information with detailed context
     * @param message - The error message
     * @param details - Detailed error information
     */
    logError(message: string, details: ErrorDetails): void {
        const sanitizedMessage = this.sanitizer.maskPassword(message);
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('='.repeat(80));
        this.outputChannel.appendLine(`[ERROR] ${new Date().toISOString()}`);
        this.outputChannel.appendLine('='.repeat(80));
        this.outputChannel.appendLine(`Message: ${sanitizedMessage}`);
        
        if (details.errorMessage) {
            const sanitizedError = this.sanitizer.maskPassword(details.errorMessage);
            this.outputChannel.appendLine(`Error: ${sanitizedError}`);
        }

        if (details.stackTrace) {
            this.outputChannel.appendLine(`\nStack Trace:`);
            const sanitizedStack = details.stackTrace.replace(/https?:\/\/[^\s]+/g, (url) =>
                this.sanitizer.maskPassword(url)
            );
            this.outputChannel.appendLine(sanitizedStack);
        }

        if (details.attemptedUrls && details.attemptedUrls.length > 0) {
            this.outputChannel.appendLine(`\nAttempted URLs:`);
            details.attemptedUrls.forEach((url, index) => {
                const sanitizedUrl = this.sanitizer.maskPassword(url);
                this.outputChannel.appendLine(`  ${index + 1}. ${sanitizedUrl}`);
            });
        }

        if (details.suggestions && details.suggestions.length > 0) {
            this.outputChannel.appendLine(`\nSuggestions:`);
            details.suggestions.forEach((suggestion, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${suggestion}`);
            });
        }

        if (details.context) {
            this.outputChannel.appendLine(`\nContext:`);
            Object.entries(details.context).forEach(([key, value]) => {
                const sanitizedValue = typeof value === 'string' 
                    ? this.sanitizer.maskPassword(value)
                    : safeStringify(value);
                this.outputChannel.appendLine(`  ${key}: ${sanitizedValue}`);
            });
        }

        this.outputChannel.appendLine('='.repeat(80));
    }

    /**
     * Logs informational message with optional details
     * @param message - The informational message
     * @param details - Optional additional details
     */
    logInfo(message: string, details?: unknown): void {
        const sanitizedMessage = this.sanitizer.maskPassword(message);
        this.outputChannel.appendLine(`[INFO] ${new Date().toISOString()} - ${sanitizedMessage}`);
        
        if (details) {
            const sanitizedDetails = typeof details === 'string'
                ? this.sanitizer.maskPassword(details)
                : safeStringify(details, 2);
            this.outputChannel.appendLine(`Details: ${sanitizedDetails}`);
        }
    }

    /**
     * Logs warning message with optional details
     * @param message - The warning message
     * @param details - Optional additional details
     */
    logWarning(message: string, details?: unknown): void {
        const sanitizedMessage = this.sanitizer.maskPassword(message);
        this.outputChannel.appendLine(`[WARNING] ${new Date().toISOString()} - ${sanitizedMessage}`);
        
        if (details) {
            const sanitizedDetails = typeof details === 'string'
                ? this.sanitizer.maskPassword(details)
                : safeStringify(details, 2);
            this.outputChannel.appendLine(`Details: ${sanitizedDetails}`);
        }
    }

    /**
     * Shows the output channel
     */
    show(): void {
        this.outputChannel.show();
    }

    /**
     * Clears the output channel
     */
    clear(): void {
        this.outputChannel.clear();
    }
}
