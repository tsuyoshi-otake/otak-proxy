import * as assert from 'assert';
import { ProxyUrl } from '../models/ProxyUrl';

suite('ProxyUrl Test Suite', () => {
    suite('constructor and toString()', () => {
        test('should create a basic proxy URL without credentials or port', () => {
            const proxy = new ProxyUrl('http', 'proxy.example.com');
            assert.strictEqual(proxy.toString(), 'http://proxy.example.com');
        });

        test('should create a proxy URL with port', () => {
            const proxy = new ProxyUrl('https', 'proxy.example.com', 8080);
            assert.strictEqual(proxy.toString(), 'https://proxy.example.com:8080');
        });

        test('should create a proxy URL with username only', () => {
            const proxy = new ProxyUrl('http', 'proxy.example.com', 8080, 'user');
            assert.strictEqual(proxy.toString(), 'http://user@proxy.example.com:8080');
        });

        test('should create a proxy URL with username and password', () => {
            const proxy = new ProxyUrl('http', 'proxy.example.com', 8080, 'user', 'pass123');
            assert.strictEqual(proxy.toString(), 'http://user:pass123@proxy.example.com:8080');
        });

        test('should create a proxy URL with all components', () => {
            const proxy = new ProxyUrl('https', 'secure.proxy.com', 443, 'admin', 'secret');
            assert.strictEqual(proxy.toString(), 'https://admin:secret@secure.proxy.com:443');
        });
    });

    suite('toDisplayString()', () => {
        test('should return the same URL when no credentials are present', () => {
            const proxy = new ProxyUrl('http', 'proxy.example.com', 8080);
            // URL.toString() adds a trailing slash, which is expected behavior
            assert.strictEqual(proxy.toDisplayString(), 'http://proxy.example.com:8080/');
        });

        test('should mask password in display string', () => {
            const proxy = new ProxyUrl('http', 'proxy.example.com', 8080, 'user', 'password123');
            const display = proxy.toDisplayString();
            assert.ok(display.includes('user'));
            assert.ok(display.includes('****'));
            assert.ok(!display.includes('password123'));
        });

        test('should mask password but keep username visible', () => {
            const proxy = new ProxyUrl('https', 'proxy.example.com', 443, 'admin', 'secret');
            const display = proxy.toDisplayString();
            assert.ok(display.includes('admin'));
            assert.ok(display.includes('****'));
            assert.ok(!display.includes('secret'));
        });
    });

    suite('fromString()', () => {
        test('should parse a basic HTTP URL', () => {
            const proxy = ProxyUrl.fromString('http://proxy.example.com');
            assert.strictEqual(proxy.protocol, 'http');
            assert.strictEqual(proxy.hostname, 'proxy.example.com');
            assert.strictEqual(proxy.port, undefined);
            assert.strictEqual(proxy.username, undefined);
            assert.strictEqual(proxy.password, undefined);
        });

        test('should parse a URL with port', () => {
            const proxy = ProxyUrl.fromString('https://proxy.example.com:8080');
            assert.strictEqual(proxy.protocol, 'https');
            assert.strictEqual(proxy.hostname, 'proxy.example.com');
            assert.strictEqual(proxy.port, 8080);
        });

        test('should parse a URL with credentials', () => {
            const proxy = ProxyUrl.fromString('http://user:pass@proxy.example.com:8080');
            assert.strictEqual(proxy.protocol, 'http');
            assert.strictEqual(proxy.hostname, 'proxy.example.com');
            assert.strictEqual(proxy.port, 8080);
            assert.strictEqual(proxy.username, 'user');
            assert.strictEqual(proxy.password, 'pass');
        });

        test('should throw error for invalid protocol', () => {
            assert.throws(
                () => ProxyUrl.fromString('ftp://proxy.example.com'),
                /Protocol must be http or https/
            );
        });

        test('should throw error for missing hostname', () => {
            assert.throws(() => ProxyUrl.fromString('http://'));
        });

        test('should round-trip correctly', () => {
            const original = 'https://user:pass@proxy.example.com:8080';
            const proxy = ProxyUrl.fromString(original);
            assert.strictEqual(proxy.toString(), original);
        });
    });
});
