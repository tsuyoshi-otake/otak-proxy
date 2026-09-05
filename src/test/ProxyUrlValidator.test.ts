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

        test('should accept IPv4 literals as IPv4, not as DNS labels with colons', () => {
            const result = validator.validate('http://192.0.2.10:8080');
            assert.strictEqual(result.isValid, true);
        });

        test('should accept bracketed IPv6 and reject unbracketed IPv6', () => {
            const accepted = validator.validate('http://[::1]:8080');
            assert.strictEqual(accepted.isValid, true, accepted.errors.join(', '));

            const rejected = validator.validate('http://::1:8080');
            assert.strictEqual(rejected.isValid, false);
            assert.ok(rejected.errors.some(error => error.toLowerCase().includes('bracket')));
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

        test('should reject encoded shell metacharacters in credentials', () => {
            const result = validator.validate('http://user:pass%26word@proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e =>
                e.toLowerCase().includes('password') ||
                e.toLowerCase().includes('shell') ||
                e.toLowerCase().includes('metacharacter')
            ));
        });

        test('should reject malformed percent encoding in credentials without throwing', () => {
            const result = validator.validate('http://user%ZZ:pass@proxy.example.com:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.some(e => e.includes('Invalid URL format')));
        });
    });

    suite('Encoded reserved credentials (#52)', () => {
        const encodedPasswordCases: Array<{ label: string; url: string }> = [
            { label: 'exclamation %21', url: 'http://user:abc%21def@proxy.example:8080' },
            { label: 'plus %2B', url: 'http://user:ab%2Bcd@proxy.example:8080' },
            { label: 'colon %3A', url: 'http://user:ab%3Acd@proxy.example:8080' },
            { label: 'percent %25', url: 'http://user:ab%25cd@proxy.example:8080' },
            { label: 'at %40', url: 'http://user:ab%40cd@proxy.example:8080' },
            {
                label: 'unicode',
                url: `http://user:p${encodeURIComponent(String.fromCodePoint(0xE4))}ss@proxy.example:8080`
            }
        ];

        for (const fixture of encodedPasswordCases) {
            test(`should accept ${fixture.label} in password`, () => {
                const result = validator.validate(fixture.url);
                assert.strictEqual(result.isValid, true, result.errors.join(', '));
            });
        }

        test('should accept encoded reserved characters in username', () => {
            const result = validator.validate('http://us%21er:ab%2Bcd@proxy.example:8080');
            assert.strictEqual(result.isValid, true, result.errors.join(', '));
        });

        const encodedMetacharCases = [
            { label: 'ampersand %26', url: 'http://user:ab%26cd@proxy.example:8080' },
            { label: 'pipe %7C', url: 'http://user:ab%7Ccd@proxy.example:8080' },
            { label: 'semicolon %3B', url: 'http://user:ab%3Bcd@proxy.example:8080' },
            { label: 'backtick %60', url: 'http://user:ab%60cd@proxy.example:8080' }
        ];

        for (const fixture of encodedMetacharCases) {
            test(`should reject ${fixture.label} in password`, () => {
                const result = validator.validate(fixture.url);
                assert.strictEqual(result.isValid, false);
                assert.ok(
                    result.errors.some(e =>
                        /shell|metacharacter|password|credential/i.test(e)
                    ),
                    result.errors.join(', ')
                );
            });
        }

        test('should not describe rejected credentials as alphanumeric-only', () => {
            const result = validator.validate('http://user:ab%26cd@proxy.example:8080');
            assert.strictEqual(result.isValid, false);
            assert.ok(result.errors.every(e => !/alphanumeric/i.test(e)), result.errors.join(', '));
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
                                e.toLowerCase().includes('invalid url format') ||
                                e.toLowerCase().includes('ipv6') ||
                                e.toLowerCase().includes('bracket')
                            ),
                            `Error message should mention hostname, IPv6, or invalid format for URL: ${url}. Errors: ${result.errors.join(', ')}`
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
        test('Property 11: Encoded shell metacharacters in credentials are rejected', () => {
            fc.assert(
                fc.property(
                    fc.constantFrom('http', 'https'),
                    fc.stringMatching(/^[a-zA-Z0-9]{1,8}$/),
                    fc.constantFrom(';', '|', '&', '`', '<', '>', '(', ')'),
                    fc.stringMatching(/^[a-zA-Z0-9]{0,8}$/),
                    fc.stringMatching(/^[a-zA-Z0-9]{1,8}$/),
                    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
                    (protocol, userBefore, metachar, userAfter, password, port) => {
                        const username = `${userBefore}${metachar}${userAfter}`;
                        const hostname = 'proxy.example.com';
                        let url = `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostname}`;
                        if (port) {
                            url += `:${port}`;
                        }

                        const result = validator.validate(url);

                        assert.strictEqual(result.isValid, false,
                            `encoded shell metacharacter should be rejected (${metachar})`);

                        assert.ok(
                            result.errors.some(e =>
                                e.toLowerCase().includes('username') ||
                                e.toLowerCase().includes('password') ||
                                e.toLowerCase().includes('credential') ||
                                e.toLowerCase().includes('shell') ||
                                e.toLowerCase().includes('metacharacter')
                            ),
                            `Error should mention shell/credential rejection. Errors: ${result.errors.join(', ')}`
                        );
                        assert.ok(
                            result.errors.every(e => !/alphanumeric/i.test(e)),
                            `Rejection must not be alphanumeric-only. Errors: ${result.errors.join(', ')}`
                        );
                    }
                ),
                { numRuns: 100 }
            );
        });
    });
});
