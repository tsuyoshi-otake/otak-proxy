/**
 * NotificationFormatter provides utilities for formatting notification messages.
 * Ensures messages are concise and readable by summarizing long content.
 */
export class NotificationFormatter {
    private static readonly MAX_MESSAGE_LENGTH = 200;
    private static readonly MAX_SUGGESTIONS = 3;
    private static readonly MAX_URLS = 2;

    /**
     * Summarizes a message to fit within the maximum length
     * @param message - The message to summarize
     * @param maxLength - Optional maximum length (defaults to 200)
     * @returns Summarized message
     */
    static summarize(message: string, maxLength?: number): string {
        const limit = maxLength ?? this.MAX_MESSAGE_LENGTH;
        
        if (message.length <= limit) {
            return message;
        }

        // Truncate and add ellipsis
        return message.substring(0, limit - 3) + '...';
    }

    /**
     * Summarizes a list of suggestions to show only the most important ones
     * @param suggestions - Array of suggestion strings
     * @param maxCount - Optional maximum count (defaults to 3)
     * @returns Summarized array of suggestions
     */
    static summarizeSuggestions(suggestions: string[], maxCount?: number): string[] {
        const limit = maxCount ?? this.MAX_SUGGESTIONS;
        
        if (suggestions.length <= limit) {
            return suggestions;
        }

        return suggestions.slice(0, limit);
    }

    /**
     * Summarizes a list of URLs for display in notifications
     * @param urls - Array of URL strings
     * @param maxCount - Optional maximum count (defaults to 2)
     * @returns Formatted string with summarized URLs
     */
    static summarizeUrls(urls: string[], maxCount?: number): string {
        const limit = maxCount ?? this.MAX_URLS;
        
        if (urls.length === 0) {
            return '';
        }

        if (urls.length <= limit) {
            return urls.join(', ');
        }

        const displayUrls = urls.slice(0, limit);
        const remaining = urls.length - limit;
        return `${displayUrls.join(', ')} (+${remaining} more)`;
    }

    /**
     * Formats an error message with an optional primary suggestion
     * @param message - The error message
     * @param primarySuggestion - Optional primary suggestion to include
     * @returns Formatted error message
     */
    static formatError(message: string, primarySuggestion?: string): string {
        const summarizedMessage = this.summarize(message);
        
        if (!primarySuggestion) {
            return summarizedMessage;
        }

        const summarizedSuggestion = this.summarize(primarySuggestion, 100);
        return `${summarizedMessage}\n\n💡 ${summarizedSuggestion}`;
    }
}
