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

    private static isSilent(): boolean {
        const raw = process.env.OTAK_PROXY_LOG_SILENT ?? process.env.OTAK_PROXY_TEST_SILENT;
        if (!raw) {
            return false;
        }
        const value = String(raw).trim().toLowerCase();
        return value === '1' || value === 'true' || value === 'yes';
    }

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
    private static sanitizeMessage(message: unknown): string {
        if (typeof message !== 'string') {
            return String(message);
        }

        const urlPattern = /https?:\/\/[^\s]+/g;
        return message.replace(urlPattern, (url) => this.sanitizer.maskPassword(url));
    }

    /**
     * Sanitizes all arguments in a log call
     * 
     * @param args - Arguments to sanitize
     * @returns Array of sanitized arguments
     */
    private static sanitizeArgs(...args: unknown[]): unknown[] {
        return args.map(arg => {
            if (typeof arg === 'string') {
                return this.sanitizeMessage(arg);
            } else if (arg instanceof Error) {
                // Sanitize error messages
                const sanitizedError = new Error(this.sanitizeMessage(arg.message));
                sanitizedError.name = arg.name;
                sanitizedError.stack = arg.stack ? this.sanitizeMessage(arg.stack) : arg.stack;
                return sanitizedError;
            } else if (typeof arg === 'object' && arg !== null) {
                // For objects, convert to string and sanitize
                try {
                    const jsonStr = JSON.stringify(arg);
                    return this.sanitizeMessage(typeof jsonStr === 'string' ? jsonStr : String(arg));
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
    static log(...args: unknown[]): void {
        const sanitized = this.sanitizeArgs(...args);
        if (this.isSilent()) {
            return;
        }
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
    static error(...args: unknown[]): void {
        const sanitized = this.sanitizeArgs(...args);
        if (this.isSilent()) {
            return;
        }
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
            const errorArg = sanitized.find(arg => arg instanceof Error);
            if (errorArg instanceof Error) {
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
    static warn(...args: unknown[]): void {
        const sanitized = this.sanitizeArgs(...args);
        if (this.isSilent()) {
            return;
        }
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
    static info(...args: unknown[]): void {
        const sanitized = this.sanitizeArgs(...args);
        if (this.isSilent()) {
            return;
        }
        console.info(...sanitized);
        
        // Also log to output channel
        const outputManager = this.getOutputManager();
        if (outputManager) {
            const message = sanitized.map(arg => String(arg)).join(' ');
            outputManager.logInfo(message);
        }
    }

    /**
     * Logs a debug message with sanitized content.
     *
     * Intentionally does not write to the output channel to avoid noise.
     */
    static debug(...args: unknown[]): void {
        const sanitized = this.sanitizeArgs(...args);
        if (this.isSilent()) {
            return;
        }
        console.debug(...sanitized);
    }
}
