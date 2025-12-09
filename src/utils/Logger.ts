import { InputSanitizer } from '../validation/InputSanitizer';
import { OutputChannelManager } from '../errors/OutputChannelManager';

/**
 * Logger - Provides sanitized logging functionality
 * 
 * This utility ensures that all log output is sanitized to prevent
 * credential leakage in logs, error messages, or any other output.
 * 
 * Integrated with OutputChannelManager to log to both console and output channel.
 * 
 * Requirements:
 * - 6.1: Mask passwords in logged proxy URLs
 * - 6.5: Prevent credentials from appearing in any log output
 * - 3.2: Log detailed information to output channel
 * - 3.3: Include timestamp and sanitized messages in output channel
 */
export class Logger {
    private static sanitizer = new InputSanitizer();
    private static outputManager: OutputChannelManager | null = null;

    /**
     * Gets the OutputChannelManager instance lazily
     * @returns OutputChannelManager instance or null if not available
     */
    private static getOutputManager(): OutputChannelManager | null {
        if (!this.outputManager) {
            try {
                this.outputManager = OutputChannelManager.getInstance();
            } catch (error) {
                // If OutputChannelManager is not available (e.g., in tests), continue without it
                return null;
            }
        }
        return this.outputManager;
    }

    /**
     * Sanitizes a message by masking any proxy URLs with credentials
     * 
     * @param message - The message to sanitize
     * @returns Sanitized message with masked credentials
     */
    private static sanitizeMessage(message: any): string {
        if (typeof message === 'string') {
            // Check if the message looks like it contains a URL
            // Pattern: protocol://...
            const urlPattern = /https?:\/\/[^\s]+/g;
            return message.replace(urlPattern, (url) => this.sanitizer.maskPassword(url));
        }
        
        // For non-string messages, convert to string first
        return String(message);
    }

    /**
     * Sanitizes all arguments in a log call
     * 
     * @param args - Arguments to sanitize
     * @returns Array of sanitized arguments
     */
    private static sanitizeArgs(...args: any[]): any[] {
        return args.map(arg => {
            if (typeof arg === 'string') {
                return this.sanitizeMessage(arg);
            } else if (arg instanceof Error) {
                // Sanitize error messages
                const sanitizedError = new Error(this.sanitizeMessage(arg.message));
                sanitizedError.stack = arg.stack;
                return sanitizedError;
            } else if (typeof arg === 'object' && arg !== null) {
                // For objects, convert to string and sanitize
                try {
                    const jsonStr = JSON.stringify(arg);
                    return this.sanitizeMessage(jsonStr);
                } catch {
                    return this.sanitizeMessage(String(arg));
                }
            }
            return arg;
        });
    }

    /**
     * Logs an informational message with sanitized content
     * Logs to both console and output channel
     * 
     * @param args - Messages to log
     */
    static log(...args: any[]): void {
        const sanitized = this.sanitizeArgs(...args);
        console.log(...sanitized);
        
        // Also log to output channel
        const outputManager = this.getOutputManager();
        if (outputManager) {
            const message = sanitized.map(arg => String(arg)).join(' ');
            outputManager.logInfo(message);
        }
    }

    /**
     * Logs an error message with sanitized content
     * Logs to both console and output channel
     * 
     * @param args - Error messages to log
     */
    static error(...args: any[]): void {
        const sanitized = this.sanitizeArgs(...args);
        console.error(...sanitized);
        
        // Also log to output channel with error details
        const outputManager = this.getOutputManager();
        if (outputManager) {
            const message = sanitized.map(arg => {
                if (arg instanceof Error) {
                    return arg.message;
                }
                return String(arg);
            }).join(' ');
            
            // Extract error details if available
            const errorArg = args.find(arg => arg instanceof Error);
            if (errorArg) {
                outputManager.logError(message, {
                    timestamp: new Date(),
                    errorMessage: message,
                    stackTrace: errorArg.stack
                });
            } else {
                outputManager.logError(message, {
                    timestamp: new Date(),
                    errorMessage: message
                });
            }
        }
    }

    /**
     * Logs a warning message with sanitized content
     * Logs to both console and output channel
     * 
     * @param args - Warning messages to log
     */
    static warn(...args: any[]): void {
        const sanitized = this.sanitizeArgs(...args);
        console.warn(...sanitized);
        
        // Also log to output channel
        const outputManager = this.getOutputManager();
        if (outputManager) {
            const message = sanitized.map(arg => String(arg)).join(' ');
            outputManager.logWarning(message);
        }
    }

    /**
     * Logs an informational message with sanitized content
     * Alias for log() to match console.info()
     * Logs to both console and output channel
     * 
     * @param args - Messages to log
     */
    static info(...args: any[]): void {
        const sanitized = this.sanitizeArgs(...args);
        console.info(...sanitized);
        
        // Also log to output channel
        const outputManager = this.getOutputManager();
        if (outputManager) {
            const message = sanitized.map(arg => String(arg)).join(' ');
            outputManager.logInfo(message);
        }
    }
}
