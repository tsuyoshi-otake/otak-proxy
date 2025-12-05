import { InputSanitizer } from '../validation/InputSanitizer';

/**
 * ProxyUrl - Represents a validated proxy URL with parsed components
 * 
 * This class encapsulates all components of a proxy URL and provides
 * methods for converting to string representations (both full and sanitized).
 */
export class ProxyUrl {
    protocol: 'http' | 'https';
    hostname: string;
    port?: number;
    username?: string;
    password?: string;

    private sanitizer: InputSanitizer;

    constructor(
        protocol: 'http' | 'https',
        hostname: string,
        port?: number,
        username?: string,
        password?: string
    ) {
        this.protocol = protocol;
        this.hostname = hostname;
        this.port = port;
        this.username = username;
        this.password = password;
        this.sanitizer = new InputSanitizer();
    }

    /**
     * Returns full URL string with all components
     * This includes credentials if present
     * 
     * @returns Complete URL string
     * 
     * Examples:
     * - "http://proxy.example.com:8080"
     * - "https://user:pass@proxy.example.com:8080"
     * - "http://proxy.example.com" (no port)
     */
    toString(): string {
        let url = `${this.protocol}://`;

        // Add credentials if present
        if (this.username) {
            url += this.username;
            if (this.password) {
                url += `:${this.password}`;
            }
            url += '@';
        }

        // Add hostname
        url += this.hostname;

        // Add port if present
        if (this.port) {
            url += `:${this.port}`;
        }

        return url;
    }

    /**
     * Returns URL with masked password for safe display
     * Uses InputSanitizer to ensure credentials are not exposed
     * 
     * @returns URL string with password masked by asterisks
     * 
     * Examples:
     * - "http://proxy.example.com:8080" (no credentials)
     * - "https://user:****@proxy.example.com:8080" (password masked)
     */
    toDisplayString(): string {
        const fullUrl = this.toString();
        return this.sanitizer.maskPassword(fullUrl);
    }

    /**
     * Creates a ProxyUrl instance from a URL string
     * 
     * @param url - The URL string to parse
     * @returns ProxyUrl instance
     * @throws Error if URL is invalid or missing required components
     */
    static fromString(url: string): ProxyUrl {
        const parsed = new URL(url);

        // Validate protocol
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Protocol must be http or https');
        }

        const protocol = parsed.protocol.slice(0, -1) as 'http' | 'https';
        const hostname = parsed.hostname;
        const port = parsed.port ? parseInt(parsed.port, 10) : undefined;
        const username = parsed.username || undefined;
        const password = parsed.password || undefined;

        if (!hostname) {
            throw new Error('Hostname is required');
        }

        return new ProxyUrl(protocol, hostname, port, username, password);
    }
}
