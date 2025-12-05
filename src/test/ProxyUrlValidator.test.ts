import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { urlWithShellMetacharactersGenerator, validProxyUrlGenerator, urlWithoutProtocolGenerator } from './generators';

suite('ProxyUrlValidator Test Suite', () => {
    let validator: ProxyUrlValidator;

    setup(() => {
        validator = new ProxyUrlValidator();
    });

    suite('Basic Validation', () => {
        test('should accept valid http URL', () => {
            const result = validator.validate('http://proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        test('should accept valid https URL', () => {
            const result = validator.validate('https://proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        test('should accept URL without port', () => {
            const result = validator.validate('http://proxy.example.com');
            assert.strictEqual(result.isValid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        test('should accept URL with credentials', () => {
            const result = validator.validate('http://user:pass@proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        test('should reject empty URL', () => {
            const result = validator.validate('');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('empty')));
        });

        test('should reject whitespace-only URL', () => {
            const result = validator.validate('   ');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('empty')));
        });
    });

    suite('Protocol Validation', () => {
        test('should reject URL without protocol', () => {
            const result = validator.validate('proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('http://') || e.includes('https://')));
        });

        test('should reject ftp protocol', () => {
            const result = validator.validate('ftp://proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('Protocol')));
        });

        test('should reject file protocol', () => {
            const result = validator.validate('file://proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            // URL class throws error for file:// with port, so we get "Invalid URL format"
            assert.ok(result.errors.some(e => e.includes('Invalid URL format')));
        });
    });

    suite('Port Validation', () => {
        test('should reject port 0', () => {
            const result = validator.validate('http://proxy.example.com:0');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('Port')));
        });

        test('should accept port 1', () => {
            const result = validator.validate('http://proxy.example.com:1');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept port 65535', () => {
            const result = validator.validate('http://proxy.example.com:65535');
            assert.strictEqual(result.isValid, true);
        });

        test('should reject port 65536', () => {
            const result = validator.validate('http://proxy.example.com:65536');
            assert.strictEqual(result.isValid, false);
            // URL class throws error for invalid port, so we get "Invalid URL format"
            assert.ok(result.errors.some(e => e.includes('Invalid URL format')));
        });
    });

    suite('Hostname Validation', () => {
        test('should accept hostname with dots', () => {
            const result = validator.validate('http://proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept hostname with hyphens', () => {
            const result = validator.validate('http://proxy-server.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should reject hostname with underscores', () => {
            const result = validator.validate('http://proxy_server.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('Hostname')));
        });

        test('should reject hostname with spaces', () => {
            const result = validator.validate('http://proxy server.example.com:8080');
            assert.strictEqual(result.isValid, false);
        });
    });

    suite('Shell Metacharacter Detection', () => {
        test('should detect semicolon', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com;rm -rf /');
            assert.strictEqual(result, true);
        });

        test('should detect pipe', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com|cat /etc/passwd');
            assert.strictEqual(result, true);
        });

        test('should detect ampersand', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com&whoami');
            assert.strictEqual(result, true);
        });

        test('should detect backtick', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com`whoami`');
            assert.strictEqual(result, true);
        });

        test('should detect newline', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com\nwhoami');
            assert.strictEqual(result, true);
        });

        test('should detect carriage return', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com\rwhoami');
            assert.strictEqual(result, true);
        });

        test('should detect less-than', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com</etc/passwd');
            assert.strictEqual(result, true);
        });

        test('should detect greater-than', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com>/tmp/file');
            assert.strictEqual(result, true);
        });

        test('should detect parentheses', () => {
            const result = validator.containsShellMetacharacters('http://proxy.com(whoami)');
            assert.strictEqual(result, true);
        });

        test('should not detect safe characters', () => {
            const result = validator.containsShellMetacharacters('http://user:pass@proxy.example.com:8080');
            assert.strictEqual(result, false);
        });

        test('should reject URL with shell metacharacters in validation', () => {
            const result = validator.validate('http://proxy.com;rm -rf /');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('metacharacter')));
        });
    });

    suite('Credential Validation', () => {
        test('should accept alphanumeric username and password', () => {
            const result = validator.validate('http://user123:pass456@proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept credentials with hyphens', () => {
            const result = validator.validate('http://user-name:pass-word@proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept credentials with underscores', () => {
            const result = validator.validate('http://user_name:pass_word@proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept credentials with @ symbol in username', () => {
            // Note: URL class doesn't support @ in username/password well
            // This is a known limitation - we'll accept the URL class behavior
            const result = validator.validate('http://user%40domain:password@proxy.example.com:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should reject credentials with special characters', () => {
            const result = validator.validate('http://user!name:pass$word@proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('Username') || e.includes('Password')));
        });
    });

    suite('Property-Based Tests', () => {
        /**
         * Feature: security-and-error-handling, Property 1: Shell metacharacter rejection
         * Validates: Requirements 1.1
         * 
         * For any proxy URL containing shell metacharacters (;, |, &, `, \n, \r, <, >, (, )),
         * the validation function should reject the URL and return an error message.
         */
        test('Property 1: Shell metacharacter rejection', () => {
            fc.assert(
                fc.property(
                    urlWithShellMetacharactersGenerator(),
                    (url) => {
                        const result = validator.validate(url);
                        
                        // The URL should be rejected
                        assert.strictEqual(result.isValid, false, 
                            `URL with shell metacharacters should be rejected: ${url}`);
                        
                        // The error message should mention shell metacharacters
                        assert.ok(
                            result.errors.some(e => e.toLowerCase().includes('metacharacter')),
                            `Error message should mention shell metacharacters for URL: ${url}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 2: Valid character acceptance
         * Validates: Requirements 1.3
         * 
         * For any proxy URL containing only allowed characters (alphanumeric, dots, colons,
         * hyphens, underscores, slashes, @ in credentials), the validation function should
         * accept the URL if it is otherwise well-formed.
         */
        test('Property 2: Valid character acceptance', () => {
            fc.assert(
                fc.property(
                    validProxyUrlGenerator(),
                    (url) => {
                        const result = validator.validate(url);
                        
                        // The URL should be accepted since it contains only valid characters
                        assert.strictEqual(result.isValid, true, 
                            `URL with only valid characters should be accepted: ${url}. Errors: ${result.errors.join(', ')}`);
                        
                        // There should be no errors
                        assert.strictEqual(result.errors.length, 0,
                            `URL with only valid characters should have no errors: ${url}. Errors: ${result.errors.join(', ')}`);
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 7: Protocol requirement
         * Validates: Requirements 3.2
         * 
         * For any proxy URL missing the http:// or https:// protocol prefix,
         * the validation function should reject the URL with a message requesting the protocol.
         */
        test('Property 7: Protocol requirement', () => {
            fc.assert(
                fc.property(
                    urlWithoutProtocolGenerator(),
                    (url) => {
                        const result = validator.validate(url);
                        
                        // The URL should be rejected
                        assert.strictEqual(result.isValid, false, 
                            `URL without protocol should be rejected: ${url}`);
                        
                        // The error message should mention protocol requirement
                        assert.ok(
                            result.errors.some(e => 
                                e.toLowerCase().includes('protocol') || 
                                e.toLowerCase().includes('http://') || 
                                e.toLowerCase().includes('https://')
                            ),
                            `Error message should mention protocol requirement for URL: ${url}. Errors: ${result.errors.join(', ')}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 8: Port range validation
         * Validates: Requirements 3.3
         * 
         * For any proxy URL with a port number outside the range 1-65535,
         * the validation function should reject the URL with a message showing the valid range.
         */
        test('Property 8: Port range validation', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    fc.stringMatching(/^[a-zA-Z0-9.-]+$/).filter(s => s.length >= 3 && s.length <= 50),
                    fc.oneof(
                        fc.integer({ min: -1000, max: 0 }),
                        fc.integer({ min: 65536, max: 100000 })
                    ),
                    (protocol, hostname, port) => {
                        const url = `${protocol}://${hostname}:${port}`;
                        const result = validator.validate(url);
                        
                        // The URL should be rejected
                        assert.strictEqual(result.isValid, false, 
                            `URL with invalid port ${port} should be rejected: ${url}`);
                        
                        // The error message should mention port range or be an invalid URL format error
                        // Note: URL class may throw "Invalid URL format" for some invalid ports
                        assert.ok(
                            result.errors.some(e => 
                                e.toLowerCase().includes('port') || 
                                e.toLowerCase().includes('invalid url format')
                            ),
                            `Error message should mention port range or invalid format for URL: ${url}. Errors: ${result.errors.join(', ')}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 9: Hostname validation
         * Validates: Requirements 3.4
         * 
         * For any proxy URL with a hostname containing invalid characters (anything other than
         * alphanumeric, dots, hyphens), the validation function should reject the URL with an
         * explanation of hostname requirements.
         */
        test('Property 9: Hostname validation', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    fc.string({ minLength: 1, maxLength: 20 }).filter(s => {
                        // Exclude shell metacharacters and @ to avoid security/credential check rejection
                        const excludedChars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')', '@'];
                        return !excludedChars.some(char => s.includes(char));
                    }),
                    // Invalid characters for hostname (excluding shell metacharacters and @)
                    fc.constantFrom('!', '#', '$', '%', '^', '*', '=', '+', '[', ']', '{', '}', '_', ' ', '~', '/', '\\', '?', ','),
                    fc.string({ minLength: 0, maxLength: 20 }).filter(s => {
                        // Exclude shell metacharacters and @ to avoid security/credential check rejection
                        const excludedChars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')', '@'];
                        return !excludedChars.some(char => s.includes(char));
                    }),
                    (protocol, before, invalidChar, after) => {
                        const hostname = `${before}${invalidChar}${after}`;
                        const url = `${protocol}://${hostname}.com:8080`;
                        const result = validator.validate(url);
                        
                        // The URL should be rejected
                        assert.strictEqual(result.isValid, false, 
                            `URL with invalid hostname character '${invalidChar}' should be rejected: ${url}`);
                        
                        // The error message should mention hostname requirements or be an invalid URL format error
                        // Note: URL class may throw "Invalid URL format" for some invalid characters
                        assert.ok(
                            result.errors.some(e => 
                                e.toLowerCase().includes('hostname') || 
                                e.toLowerCase().includes('invalid url format')
                            ),
                            `Error message should mention hostname requirements or invalid format for URL: ${url}. Errors: ${result.errors.join(', ')}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });

        /**
         * Feature: security-and-error-handling, Property 11: Credential format validation
         * Validates: Requirements 4.2
         * 
         * For any proxy URL containing authentication credentials, the validator should verify
         * that the username and password contain only allowed characters and are properly formatted.
         */
        test('Property 11: Credential format validation', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    // Generate username with invalid characters (excluding shell metacharacters)
                    fc.string({ minLength: 1, maxLength: 10 }).filter(s => {
                        // Exclude shell metacharacters to focus on credential validation
                        const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
                        return !shellMetachars.some(char => s.includes(char));
                    }),
                    // Invalid characters for credentials (excluding shell metacharacters and @)
                    fc.constantFrom('!', '#', '$', '%', '^', '*', '=', '+', '[', ']', '{', '}', ' ', '~', '/', '\\', '?', ',', '.', ':'),
                    fc.string({ minLength: 0, maxLength: 10 }).filter(s => {
                        // Exclude shell metacharacters to focus on credential validation
                        const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
                        return !shellMetachars.some(char => s.includes(char));
                    }),
                    fc.string({ minLength: 1, maxLength: 10 }).filter(s => {
                        // Exclude shell metacharacters to focus on credential validation
                        const shellMetachars = [';', '|', '&', '`', '\n', '\r', '<', '>', '(', ')'];
                        return !shellMetachars.some(char => s.includes(char));
                    }),
                    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                    (protocol, userBefore, invalidChar, userAfter, password, port) => {
                        // Create username with invalid character
                        const username = `${userBefore}${invalidChar}${userAfter}`;
                        // Use a valid hostname to ensure we're testing credential validation, not hostname validation
                        const hostname = 'proxy.example.com';
                        let url = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostname}`;
                        if (port) {
                            url += `:${port}`;
                        }
                        
                        const result = validator.validate(url);
                        
                        // The URL should be rejected due to invalid credential characters
                        assert.strictEqual(result.isValid, false, 
                            `URL with invalid credential character '${invalidChar}' should be rejected: ${url}`);
                        
                        // The error message should mention username or password validation
                        assert.ok(
                            result.errors.some(e => 
                                e.toLowerCase().includes('username') || 
                                e.toLowerCase().includes('password') ||
                                e.toLowerCase().includes('credential')
                            ),
                            `Error message should mention credential validation for URL: ${url}. Errors: ${result.errors.join(', ')}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
