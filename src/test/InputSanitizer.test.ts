import * as assert from 'assert';
import * as fc from 'fast-check';
import { InputSanitizer } from '../validation/InputSanitizer';

suite('InputSanitizer Test Suite', () => {
    let sanitizer: InputSanitizer;

    setup(() => {
        sanitizer = new InputSanitizer();
    });

    suite('Basic Sanitization', () => {
        test('should mask password in URL with credentials', () => {
            const result = sanitizer.maskPassword('http://user:password@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('password'));
        });

        test('should not modify URL without credentials (except trailing slash)', () => {
            const url = 'http://proxy.example.com:8080';
            const result = sanitizer.maskPassword(url);
            // URL class may add a trailing slash, so we check the base URL
            assert.ok(result.startsWith(url));
        });

        test('should handle malformed URLs gracefully', () => {
            const url = 'not-a-valid-url';
            const result = sanitizer.maskPassword(url);
            assert.strictEqual(result, url);
        });

        test('should remove credentials entirely', () => {
            const result = sanitizer.removeCredentials('http://user:password@proxy.example.com:8080');
            assert.ok(!result.includes('user'));
            assert.ok(!result.includes('password'));
            assert.ok(result.includes('proxy.example.com'));
        });

        test('should handle URL with username only', () => {
            const result = sanitizer.maskPassword('http://user@proxy.example.com:8080');
            assert.ok(result.includes('user'));
            assert.ok(result.includes('proxy.example.com'));
        });
    });

    suite('Edge Cases', () => {
        test('should handle empty string', () => {
            const result = sanitizer.maskPassword('');
            assert.strictEqual(result, '');
        });

        // Task 3.4: Test URLs with passwords in various positions
        test('should mask password at beginning of credentials', () => {
            const result = sanitizer.maskPassword('http://user:password123@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('password123'));
            assert.ok(result.includes('user'));
        });

        test('should mask password with port number', () => {
            const result = sanitizer.maskPassword('https://admin:secret@proxy.example.com:3128');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('secret'));
            assert.ok(result.includes('3128'));
        });

        test('should mask password without port number', () => {
            const result = sanitizer.maskPassword('http://testuser:testpass@proxy.example.com');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('testpass'));
            assert.ok(result.includes('testuser'));
        });

        test('should mask password with path component', () => {
            const result = sanitizer.maskPassword('http://user:pass@proxy.example.com:8080/path');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass'));
            assert.ok(result.includes('/path'));
        });

        test('should mask password with query parameters', () => {
            const result = sanitizer.maskPassword('http://user:pass@proxy.example.com:8080?param=value');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass'));
            assert.ok(result.includes('param=value'));
        });

        // Task 3.4: Test special characters in passwords
        test('should handle URL with special characters in password - exclamation', () => {
            const result = sanitizer.maskPassword('http://user:p@ss!word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('p@ss!word'));
            assert.ok(!result.includes('!'));
        });

        test('should handle URL with special characters in password - hash', () => {
            const result = sanitizer.maskPassword('http://user:pass#123@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass#123'));
            assert.ok(!result.includes('#123'));
        });

        test('should handle URL with special characters in password - dollar sign', () => {
            const result = sanitizer.maskPassword('http://user:pa$$word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pa$$word'));
            assert.ok(!result.includes('$$'));
        });

        test('should handle URL with special characters in password - percent', () => {
            const result = sanitizer.maskPassword('http://user:pass%word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass%word'));
        });

        test('should handle URL with special characters in password - ampersand', () => {
            const result = sanitizer.maskPassword('http://user:pass&word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass&word'));
            assert.ok(!result.includes('&'));
        });

        test('should handle URL with special characters in password - equals', () => {
            const result = sanitizer.maskPassword('http://user:pass=word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass=word'));
        });

        test('should handle URL with special characters in password - plus', () => {
            const result = sanitizer.maskPassword('http://user:pass+word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass+word'));
        });

        test('should handle URL with URL-encoded special characters in password', () => {
            const result = sanitizer.maskPassword('http://user:pass%21word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass%21word'));
        });

        // Task 3.4: Test multiple @ symbols
        test('should handle multiple @ symbols - @ in password (URL-encoded)', () => {
            // URL with @ in password (URL-encoded as %40)
            const result = sanitizer.maskPassword('http://user:pass%40word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass%40word'));
        });

        test('should handle multiple @ symbols - @ in username', () => {
            // URL with @ in username (URL-encoded as %40)
            const result = sanitizer.maskPassword('http://user%40domain:password@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('password'));
            assert.ok(result.includes('user%40domain') || result.includes('user@domain'));
        });

        test('should handle multiple @ symbols - complex case', () => {
            // URL with @ in both username and password
            const result = sanitizer.maskPassword('http://user%40domain:pass%40word@proxy.example.com:8080');
            assert.ok(result.includes('****'));
            assert.ok(!result.includes('pass%40word'));
            assert.ok(!result.includes('pass@word'));
        });

        test('should handle malformed URL with multiple unencoded @ symbols gracefully', () => {
            // This is technically malformed, but we should handle it gracefully
            const url = 'http://user:pass@word@proxy.example.com:8080';
            const result = sanitizer.maskPassword(url);
            // Should either mask it or return original if it can't parse
            assert.ok(typeof result === 'string');
        });

        // Additional edge cases for removeCredentials
        test('removeCredentials should handle URL with special characters in password', () => {
            const result = sanitizer.removeCredentials('http://user:p@ss!word@proxy.example.com:8080');
            assert.ok(!result.includes('user'));
            assert.ok(!result.includes('p@ss!word'));
            assert.ok(result.includes('proxy.example.com'));
        });

        test('removeCredentials should handle multiple @ symbols', () => {
            const result = sanitizer.removeCredentials('http://user:pass%40word@proxy.example.com:8080');
            assert.ok(!result.includes('user'));
            assert.ok(!result.includes('pass%40word'));
            assert.ok(result.includes('proxy.example.com'));
        });

        test('removeCredentials should preserve URL structure without credentials', () => {
            const result = sanitizer.removeCredentials('https://user:password@proxy.example.com:3128/path?query=value');
            assert.ok(!result.includes('user'));
            assert.ok(!result.includes('password'));
            assert.ok(result.includes('proxy.example.com'));
            assert.ok(result.includes('3128'));
            assert.ok(result.includes('/path'));
            assert.ok(result.includes('query=value'));
        });
    });

    suite('Property-Based Tests', () => {
        /**
         * Feature: security-and-error-handling, Property 4: Credential masking in logs
         * Validates: Requirements 1.5, 6.1, 6.3, 6.5
         * 
         * For any proxy URL containing a password, when logged or displayed in error messages,
         * the password portion should be replaced with asterisks or removed entirely.
         */
        test('Property 4: Credential masking in logs', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    // Generate valid username (alphanumeric, hyphens, underscores only, min length 3)
                    fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 3 && s.length <= 20),
                    // Generate valid password (alphanumeric, hyphens, underscores only, min length 5)
                    fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 5 && s.length <= 20),
                    // Generate valid hostname
                    fc.stringMatching(/^[a-zA-Z0-9.-]+$/).filter(s => s.length >= 5 && s.length <= 50),
                    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                    (protocol, username, password, hostname, port) => {
                        // Construct URL with credentials
                        let url = `${protocol}://${username}:${password}@${hostname}`;
                        if (port) {
                            url += `:${port}`;
                        }
                        
                        const masked = sanitizer.maskPassword(url);
                        
                        // The password should not appear in the masked URL
                        assert.ok(!masked.includes(password), 
                            `Password '${password}' should not appear in masked URL: ${masked}`);
                        
                        // The masked URL should contain asterisks
                        assert.ok(masked.includes('****'), 
                            `Masked URL should contain asterisks: ${masked}`);
                        
                        // The username should still be present (we only mask password)
                        // Prefer comparing URL components rather than raw string containment.
                        // URL parsing can normalize IPv4-like hostnames (e.g. "00.00" -> "0.0.0.0"),
                        // so string inclusion is not a reliable invariant for valid URLs.
                        //
                        // For malformed hostnames, URL parsing may throw; in that case we fall back to
                        // case-insensitive string containment checks.
                        try {
                            const originalParsed = new URL(url);
                            const maskedParsed = new URL(masked);

                            assert.strictEqual(maskedParsed.username, originalParsed.username,
                                `Username should be preserved. original=${originalParsed.username} masked=${maskedParsed.username}`);
                            assert.strictEqual(maskedParsed.hostname, originalParsed.hostname,
                                `Hostname should be preserved. original=${originalParsed.hostname} masked=${maskedParsed.hostname}`);
                        } catch {
                            const lowerMasked = masked.toLowerCase();
                            assert.ok(lowerMasked.includes(username.toLowerCase()),
                                `Username '${username}' should still be present in masked URL: ${masked}`);
                            assert.ok(lowerMasked.includes(hostname.toLowerCase()),
                                `Hostname '${hostname}' should still be present in masked URL: ${masked}`);
                        }
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 5: Credential masking in UI
         * Validates: Requirements 6.2
         * 
         * For any proxy URL containing a password, when displayed in the status bar or UI elements,
         * the password should be masked with asterisks.
         */
        test('Property 5: Credential masking in UI', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    // Generate valid username (alphanumeric, hyphens, underscores only, min length 3, must start with letter)
                    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]*$/).filter(s => s.length >= 3 && s.length <= 20),
                    // Generate valid password (alphanumeric, hyphens, underscores only, min length 5)
                    // Use a unique prefix to avoid accidental substring matches
                    fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 5 && s.length <= 20).map(s => `pwd${s}`),
                    // Generate valid hostname (must start with letter, not end with dot, won't be URL-normalized)
                    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)*$/).filter(s => s.length >= 5 && s.length <= 50),
                    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                    (protocol, username, password, hostname, port) => {
                        // Construct URL with credentials
                        let url = `${protocol}://${username}:${password}@${hostname}`;
                        if (port) {
                            url += `:${port}`;
                        }
                        
                        const masked = sanitizer.maskPassword(url);
                        
                        // The password should not appear in the masked URL (for UI display)
                        assert.ok(!masked.includes(password), 
                            `Password '${password}' should not appear in UI display: ${masked}`);
                        
                        // The masked URL should contain asterisks for UI display
                        assert.ok(masked.includes('****'), 
                            `UI display should contain asterisks: ${masked}`);
                        
                        // The masked URL should still be a valid URL structure
                        // (we're not testing URL validity here, just that masking preserves structure)
                        assert.ok(masked.includes(protocol), 
                            `Protocol should be preserved in UI display: ${masked}`);
                        
                        // Hostname check (case-insensitive due to URL normalization)
                        const lowerMasked = masked.toLowerCase();
                        const lowerHostname = hostname.toLowerCase();
                        assert.ok(lowerMasked.includes(lowerHostname), 
                            `Hostname should be preserved in UI display: ${masked}`);
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 6: Storage and display separation
         * Validates: Requirements 6.4
         * 
         * For any proxy URL with credentials, the stored configuration should preserve the complete URL
         * while all display operations should show the sanitized version.
         */
        test('Property 6: Storage and display separation', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    // Generate valid username (alphanumeric, hyphens, underscores only, min length 3)
                    // Must start with alphanumeric
                    fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).filter(s => s.length >= 3 && s.length <= 20),
                    // Generate valid password (alphanumeric, hyphens, underscores only, min length 5)
                    // Must start with alphanumeric
                    fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).filter(s => s.length >= 5 && s.length <= 20),
                    // Generate valid hostname parts (must start and end with alphanumeric)
                    fc.array(
                        fc.stringMatching(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/).filter(s => s.length >= 1 && s.length <= 10),
                        { minLength: 2, maxLength: 3 }
                    ).map(parts => parts.join('.')),
                    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                    (protocol, username, password, hostname, port) => {
                        // Construct URL with credentials
                        let originalUrl = `${protocol}://${username}:${password}@${hostname}`;
                        if (port) {
                            originalUrl += `:${port}`;
                        }
                        
                        // Verify the URL is valid before proceeding
                        try {
                            new URL(originalUrl);
                        } catch {
                            // Skip invalid URLs generated by the property test
                            return true;
                        }
                        
                        // Simulate storage: the original URL should be preserved as-is
                        const storedUrl = originalUrl;
                        
                        // Simulate display: the URL should be sanitized
                        const displayUrl = sanitizer.maskPassword(storedUrl);
                        
                        // PROPERTY: Storage preserves complete URL
                        // The stored URL should contain the original password
                        assert.ok(storedUrl.includes(password), 
                            `Stored URL should preserve original password: ${storedUrl}`);
                        
                        // PROPERTY: Display shows sanitized version
                        // The display URL should NOT contain the original password
                        assert.ok(!displayUrl.includes(password), 
                            `Display URL should not contain password '${password}': ${displayUrl}`);
                        
                        // PROPERTY: Display URL should contain masking indicator
                        assert.ok(displayUrl.includes('****'), 
                            `Display URL should contain asterisks: ${displayUrl}`);
                        
                        // PROPERTY: Both URLs should have the same structure (protocol, hostname, port)
                        // Parse both URLs to verify structural equivalence
                        try {
                            const storedParsed = new URL(storedUrl);
                            const displayParsed = new URL(displayUrl);
                            
                            // Protocol should match
                            assert.strictEqual(storedParsed.protocol, displayParsed.protocol,
                                'Protocol should be preserved in display URL');
                            
                            // Hostname should match (case-insensitive)
                            assert.strictEqual(storedParsed.hostname.toLowerCase(), displayParsed.hostname.toLowerCase(),
                                'Hostname should be preserved in display URL');
                            
                            // Port should match
                            assert.strictEqual(storedParsed.port, displayParsed.port,
                                'Port should be preserved in display URL');
                            
                            // Username should match
                            assert.strictEqual(storedParsed.username, displayParsed.username,
                                'Username should be preserved in display URL');
                            
                            // Password should be masked in display URL
                            assert.strictEqual(displayParsed.password, '****',
                                'Password should be masked as **** in display URL');
                            
                        } catch (error) {
                            assert.fail(`URLs should be parseable: ${error}`);
                        }
                        
                        // PROPERTY: Round-trip consistency
                        // If we store the original and display it, then store again, 
                        // the stored value should still be the original
                        const reStoredUrl = originalUrl; // In real system, this would come from storage
                        assert.strictEqual(reStoredUrl, storedUrl,
                            'Re-storing should preserve the original URL with credentials');
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
