import * as assert from 'assert';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';

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
});
