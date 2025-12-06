/**
 * Example property-based test to verify infrastructure setup
 * This file demonstrates that fast-check is properly configured
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
    validProxyUrlGenerator,
    urlWithShellMetacharactersGenerator,
    urlWithCredentialsGenerator
} from './generators';
import { getPropertyTestRuns } from './helpers';

// Helper functions for testing
function hasValidProtocol(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
}

function containsShellMetacharacters(url: string): boolean {
    const shellMetachars = ['|', '&', ';', '$', '`', '\n', '<', '>', '(', ')', '{', '}', '[', ']', '!', '#', '*', '?', '~'];
    return shellMetachars.some(char => url.includes(char));
}

function extractPassword(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.password || null;
    } catch {
        return null;
    }
}

suite('Property-Based Testing Infrastructure', () => {
    
    test('Infrastructure: fast-check is working', () => {
        // Simple property test to verify fast-check is installed and working
        fc.assert(
            fc.property(fc.integer(), (n) => {
                return n + 0 === n;
            }),
            { numRuns: 100 }
        );
    });

    test('Infrastructure: Valid URL generator produces URLs with protocols', () => {
        fc.assert(
            fc.property(validProxyUrlGenerator(), (url) => {
                return hasValidProtocol(url);
            }),
            { numRuns: 100 }
        );
    });

    test('Infrastructure: Shell metacharacter generator produces dangerous URLs', () => {
        fc.assert(
            fc.property(urlWithShellMetacharactersGenerator(), (url) => {
                return containsShellMetacharacters(url);
            }),
            { numRuns: 100 }
        );
    });

    test('Infrastructure: Credential generator produces URLs with passwords', () => {
        fc.assert(
            fc.property(urlWithCredentialsGenerator(), (url) => {
                const password = extractPassword(url);
                return password !== null && password.length > 0;
            }),
            { numRuns: 100 }
        );
    });

    test('Infrastructure: Property tests run minimum 100 iterations', () => {
        let runCount = 0;
        
        fc.assert(
            fc.property(fc.integer(), (_n) => {
                runCount++;
                return true;
            }),
            { numRuns: 100 }
        );
        
        assert.strictEqual(runCount, 100, 'Property test should run exactly 100 times');
    });
});
