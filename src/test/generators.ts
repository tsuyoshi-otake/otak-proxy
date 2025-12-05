/**
 * Property-based test generators for proxy URL validation
 * These generators create random test data for property-based testing
 */

import * as fc from 'fast-check';

/**
 * Generates valid proxy URLs with proper format
 * Protocol: http or https
 * Hostname: alphanumeric, dots, hyphens
 * Port: 1-65535 (optional)
 * Credentials: alphanumeric, hyphens, underscores (optional)
 */
export const validProxyUrlGenerator = (): fc.Arbitrary<string> => {
    const protocolArb = fc.constantFrom('http', 'https');
    
    // Valid hostname part: must start with alphanumeric, can contain hyphens
    // Each part must be at least 1 character and not start/end with hyphen
    const hostnamePartArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/)
        .filter(s => s.length >= 1 && s.length <= 63);
    
    // Generate hostname with 2-4 parts (e.g., proxy.example.com)
    const hostnameArb = fc.array(hostnamePartArb, { minLength: 2, maxLength: 4 })
        .map(parts => parts.join('.'))
        .filter(hostname => {
            // Ensure the hostname is valid for URL parsing
            try {
                new URL(`http://${hostname}`);
                return true;
            } catch {
                return false;
            }
        });
    
    // Valid port: 1-65535
    const portArb = fc.integer({ min: 1, max: 65535 });
    
    // Valid credentials: alphanumeric, hyphens, underscores (at least 1 char)
    const credentialPartArb = fc.stringMatching(/^[a-zA-Z0-9_-]+$/)
        .filter(s => s.length >= 1 && s.length <= 20);
    
    return fc.record({
        protocol: protocolArb,
        hostname: hostnameArb,
        port: fc.option(portArb, { nil: undefined }),
        username: fc.option(credentialPartArb, { nil: undefined }),
        password: fc.option(credentialPartArb, { nil: undefined })
    }).map(({ protocol, hostname, port, username, password }) => {
        let url = `${protocol}://`;
        
        if (username && password) {
            url += `${username}:${password}@`;
        }
        
        url += hostname;
        
        if (port) {
            url += `:${port}`;
        }
        
        return url;
    });
};

/**
 * Generates URLs containing shell metacharacters
 * These should be rejected by validation
 */
export const urlWithShellMetacharactersGenerator = (): fc.Arbitrary<string> => {
    const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
    const metacharArb = fc.constantFrom(...shellMetachars);
    
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.string(),
        metacharArb,
        fc.string()
    ).map(([protocol, before, metachar, after]) => {
        return `${protocol}://proxy.com${before}${metachar}${after}`;
    });
};

/**
 * Generates URLs without protocol
 * These should be rejected by validation
 */
export const urlWithoutProtocolGenerator = (): fc.Arbitrary<string> => {
    // Shell metacharacters to exclude
    const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
    
    return fc.string({ minLength: 5 })
        .filter(s => {
            // Exclude strings that start with protocol
            if (s.startsWith('http://') || s.startsWith('https://')) {
                return false;
            }
            // Exclude strings containing shell metacharacters
            return !shellMetachars.some(char => s.includes(char));
        })
        .map(s => `proxy.com:8080${s}`);
};

/**
 * Generates URLs with invalid port numbers
 * Ports outside range 1-65535
 */
export const urlWithInvalidPortGenerator = (): fc.Arbitrary<string> => {
    const invalidPortArb = fc.oneof(
        fc.integer({ min: -1000, max: 0 }),
        fc.integer({ min: 65536, max: 100000 })
    );
    
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.string({ minLength: 3 }),
        invalidPortArb
    ).map(([protocol, hostname, port]) => {
        return `${protocol}://${hostname}:${port}`;
    });
};

/**
 * Generates URLs with invalid hostname characters
 * Contains characters other than alphanumeric, dots, hyphens
 */
export const urlWithInvalidHostnameGenerator = (): fc.Arbitrary<string> => {
    const invalidChars = ['!', '@', '#', '$', '%', '^', '*', '(', ')', '=', '+', '[', ']', '{', '}'];
    const invalidCharArb = fc.constantFrom(...invalidChars);
    
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.string(),
        invalidCharArb,
        fc.string()
    ).map(([protocol, before, invalidChar, after]) => {
        return `${protocol}://${before}${invalidChar}${after}.com:8080`;
    });
};

/**
 * Generates URLs with credentials containing various formats
 * Used to test credential validation and masking
 */
export const urlWithCredentialsGenerator = (): fc.Arbitrary<string> => {
    // Valid credentials: alphanumeric, hyphens, underscores only
    const usernameArb = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 1 && s.length <= 20);
    const passwordArb = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 1 && s.length <= 20);
    // Valid hostname: alphanumeric, dots, hyphens only
    const hostnameArb = fc.stringMatching(/^[a-zA-Z0-9.-]+$/).filter(s => s.length >= 3 && s.length <= 50);
    
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        usernameArb,
        passwordArb,
        hostnameArb,
        fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined })
    ).map(([protocol, username, password, hostname, port]) => {
        let url = `${protocol}://${username}:${password}@${hostname}`;
        if (port) {
            url += `:${port}`;
        }
        return url;
    });
};

/**
 * Generates empty or whitespace-only strings
 * Used to test edge case handling
 */
export const emptyOrWhitespaceGenerator = (): fc.Arbitrary<string> => {
    return fc.oneof(
        fc.constant(''),
        fc.stringMatching(/^\s+$/)
    );
};

/**
 * Generates URLs with multiple @ symbols
 * Edge case for credential parsing
 */
export const urlWithMultipleAtSymbolsGenerator = (): fc.Arbitrary<string> => {
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 })
    ).map(([protocol, part1, part2, part3]) => {
        return `${protocol}://${part1}@${part2}@${part3}.com:8080`;
    });
};

/**
 * Generates URLs with invalid credential characters
 * Used to test credential format validation
 */
export const urlWithInvalidCredentialsGenerator = (): fc.Arbitrary<string> => {
    // Invalid characters for credentials (excluding shell metacharacters)
    const invalidChars = ['!', '#', '$', '%', '^', '*', '=', '+', '[', ']', '{', '}', ' ', '~', '/', '\\', '?', ',', '.', ':'];
    const invalidCharArb = fc.constantFrom(...invalidChars);
    
    const usernameArb = fc.tuple(
        fc.string({ minLength: 0, maxLength: 10 }),
        invalidCharArb,
        fc.string({ minLength: 0, maxLength: 10 })
    ).map(([before, invalidChar, after]) => `${before}${invalidChar}${after}`);
    
    const passwordArb = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 1 && s.length <= 20);
    const hostnameArb = fc.stringMatching(/^[a-zA-Z0-9.-]+$/).filter(s => s.length >= 3 && s.length <= 50);
    
    return fc.tuple(
        fc.constantFrom('http', 'https'),
        usernameArb,
        passwordArb,
        hostnameArb,
        fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined })
    ).map(([protocol, username, password, hostname, port]) => {
        let url = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostname}`;
        if (port) {
            url += `:${port}`;
        }
        return url;
    });
};
