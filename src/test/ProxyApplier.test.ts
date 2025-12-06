/**
 * Unit tests for ProxyApplier
 * 
 * These tests verify the basic functionality of ProxyApplier:
 * - applyProxy method
 * - disableProxy method
 */

import * as assert from 'assert';
import { ProxyApplier } from '../core/ProxyApplier';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';

suite('ProxyApplier Unit Tests', () => {
    test('applyProxy with valid URL succeeds when all managers succeed', async () => {
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        const result = await applier.applyProxy('http://proxy.example.com:8080', true);
        assert.strictEqual(result, true, 'applyProxy should return true when all managers succeed');
    });

    test('applyProxy with invalid URL fails validation', async () => {
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        let errorShown = false;
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => { errorShown = true; },
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        const result = await applier.applyProxy('invalid-url', true);
        assert.strictEqual(result, false, 'applyProxy should return false for invalid URL');
        assert.strictEqual(errorShown, true, 'Error should be shown for invalid URL');
    });

    test('applyProxy with empty URL calls disableProxy', async () => {
        let disableCalled = false;
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => {
                disableCalled = true;
                return { success: true };
            }
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        await applier.applyProxy('', true);
        assert.strictEqual(disableCalled, true, 'Empty URL should trigger disableProxy');
    });

    test('applyProxy returns false when any manager fails', async () => {
        const mockGitManager = {
            setProxy: async () => ({ success: false, error: 'Git failed' }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        let errorShown = false;
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => { errorShown = true; },
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        const result = await applier.applyProxy('http://proxy.example.com:8080', true);
        assert.strictEqual(result, false, 'applyProxy should return false when any manager fails');
        assert.strictEqual(errorShown, true, 'Error should be shown when manager fails');
    });

    test('disableProxy calls unsetProxy on all managers', async () => {
        const unsetCalls: string[] = [];
        
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => {
                unsetCalls.push('git');
                return { success: true };
            }
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => {
                unsetCalls.push('vscode');
                return { success: true };
            }
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => {
                unsetCalls.push('npm');
                return { success: true };
            }
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        await applier.disableProxy();
        assert.strictEqual(unsetCalls.length, 3, 'All three managers should have unsetProxy called');
        assert.ok(unsetCalls.includes('git'), 'Git manager should have unsetProxy called');
        assert.ok(unsetCalls.includes('vscode'), 'VSCode manager should have unsetProxy called');
        assert.ok(unsetCalls.includes('npm'), 'npm manager should have unsetProxy called');
    });

    test('disableProxy returns true when all managers succeed', async () => {
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        const result = await applier.disableProxy();
        assert.strictEqual(result, true, 'disableProxy should return true when all managers succeed');
    });

    test('disableProxy returns false when any manager fails', async () => {
        const mockGitManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: false, error: 'Git failed' })
        } as any;
        
        const mockVscodeManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockNpmManager = {
            setProxy: async () => ({ success: true }),
            unsetProxy: async () => ({ success: true })
        } as any;
        
        const mockValidator = new ProxyUrlValidator();
        const mockSanitizer = new InputSanitizer();
        let errorShown = false;
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => { errorShown = true; },
            showWarning: () => {}
        } as any;
        
        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            mockValidator,
            mockSanitizer,
            mockNotifier
        );
        
        const result = await applier.disableProxy();
        assert.strictEqual(result, false, 'disableProxy should return false when any manager fails');
        assert.strictEqual(errorShown, true, 'Error should be shown when manager fails');
    });
});
