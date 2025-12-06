/**
 * Property-based tests for ProxyApplier
 * 
 * These tests verify the correctness properties defined in the design document:
 * - Property 5: Proxy enablement sequence
 * - Property 6: Proxy disablement completeness
 * - Property 7: Error aggregation on failure
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ProxyApplier } from '../core/ProxyApplier';
import { GitConfigManager } from '../config/GitConfigManager';
import { VscodeConfigManager } from '../config/VscodeConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { UserNotifier } from '../errors/UserNotifier';
import { ProxyStateManager } from '../core/ProxyStateManager';
import { getPropertyTestRuns } from './helpers';

/**
 * Feature: extension-refactoring, Property 5: Proxy enablement sequence
 * Validates: Requirements 4.2
 * 
 * For any valid proxy URL, enabling the proxy should execute validation,
 * then application, then error aggregation in that order.
 */
suite('ProxyApplier Property Tests', () => {
    test('Property 5: Proxy enablement follows validation -> application -> error aggregation sequence', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.webUrl({ validSchemes: ['http', 'https'] }),
                async (proxyUrl) => {
                    // Track the order of operations
                    const operationOrder: string[] = [];
                    
                    // Create mock managers that track when they're called
                    const mockGitManager = {
                        setProxy: async (url: string) => {
                            operationOrder.push('git-apply');
                            return { success: true };
                        },
                        unsetProxy: async () => {
                            operationOrder.push('git-unset');
                            return { success: true };
                        }
                    } as any;
                    
                    const mockVscodeManager = {
                        setProxy: async (url: string) => {
                            operationOrder.push('vscode-apply');
                            return { success: true };
                        },
                        unsetProxy: async () => {
                            operationOrder.push('vscode-unset');
                            return { success: true };
                        }
                    } as any;
                    
                    const mockNpmManager = {
                        setProxy: async (url: string) => {
                            operationOrder.push('npm-apply');
                            return { success: true };
                        },
                        unsetProxy: async () => {
                            operationOrder.push('npm-unset');
                            return { success: true };
                        }
                    } as any;
                    
                    // Create a validator that tracks when it's called
                    const mockValidator = {
                        validate: (url: string) => {
                            operationOrder.push('validation');
                            return { isValid: true, errors: [] };
                        }
                    } as any;
                    
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
                    
                    // Apply proxy
                    await applier.applyProxy(proxyUrl, true);
                    
                    // Verify validation happens first
                    assert.strictEqual(operationOrder[0], 'validation', 
                        'Validation should be the first operation');
                    
                    // Verify application happens after validation
                    const applicationOps = operationOrder.filter(op => 
                        op.includes('-apply'));
                    assert.ok(applicationOps.length > 0, 
                        'Application operations should occur');
                    
                    // Verify all application operations happen after validation
                    const validationIndex = operationOrder.indexOf('validation');
                    const firstApplicationIndex = operationOrder.findIndex(op => 
                        op.includes('-apply'));
                    assert.ok(firstApplicationIndex > validationIndex,
                        'Application should occur after validation');
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: extension-refactoring, Property 6: Proxy disablement completeness
     * Validates: Requirements 4.3
     * 
     * For any proxy state, disabling the proxy should call unsetProxy on all
     * ConfigManagers (Git, VSCode, npm).
     */
    test('Property 6: Proxy disablement calls unsetProxy on all ConfigManagers', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constant(null), // No input needed, just testing the behavior
                async () => {
                    // Track which managers had unsetProxy called
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
                    
                    // Disable proxy
                    await applier.disableProxy();
                    
                    // Verify all managers had unsetProxy called
                    assert.ok(unsetCalls.includes('git'), 
                        'Git manager should have unsetProxy called');
                    assert.ok(unsetCalls.includes('vscode'), 
                        'VSCode manager should have unsetProxy called');
                    assert.ok(unsetCalls.includes('npm'), 
                        'npm manager should have unsetProxy called');
                    assert.strictEqual(unsetCalls.length, 3,
                        'All three managers should have unsetProxy called');
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });

    /**
     * Feature: extension-refactoring, Property 7: Error aggregation on failure
     * Validates: Requirements 4.4
     * 
     * For any ConfigManager that fails during proxy application, the error
     * should be added to ErrorAggregator.
     */
    test('Property 7: ConfigManager failures are aggregated', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 7 }), // Bitmask for which managers fail
                async (failureMask) => {
                    // Use a fixed valid proxy URL to avoid validation errors
                    const proxyUrl = 'http://proxy.example.com:8080';
                    // Track error notifications
                    let errorShown = false;
                    let errorMessage = '';
                    
                    const gitShouldFail = (failureMask & 1) !== 0;
                    const vscodeShouldFail = (failureMask & 2) !== 0;
                    const npmShouldFail = (failureMask & 4) !== 0;
                    
                    const mockGitManager = {
                        setProxy: async () => {
                            if (gitShouldFail) {
                                return { success: false, error: 'Git failed' };
                            }
                            return { success: true };
                        },
                        unsetProxy: async () => ({ success: true })
                    } as any;
                    
                    const mockVscodeManager = {
                        setProxy: async () => {
                            if (vscodeShouldFail) {
                                return { success: false, error: 'VSCode failed' };
                            }
                            return { success: true };
                        },
                        unsetProxy: async () => ({ success: true })
                    } as any;
                    
                    const mockNpmManager = {
                        setProxy: async () => {
                            if (npmShouldFail) {
                                return { success: false, error: 'npm failed' };
                            }
                            return { success: true };
                        },
                        unsetProxy: async () => ({ success: true })
                    } as any;
                    
                    const mockValidator = new ProxyUrlValidator();
                    const mockSanitizer = new InputSanitizer();
                    const mockNotifier = {
                        showSuccess: () => {},
                        showError: (msg: string, suggestions?: string[]) => {
                            errorShown = true;
                            errorMessage = msg;
                        },
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
                    
                    // Apply proxy
                    await applier.applyProxy(proxyUrl, true);
                    
                    // If any manager failed, error should be shown
                    const anyFailure = gitShouldFail || vscodeShouldFail || npmShouldFail;
                    if (anyFailure) {
                        assert.ok(errorShown, 
                            'Error should be shown when any manager fails');
                        
                        // Verify error message contains information about failed managers
                        // ErrorAggregator formats errors as "- {operation}: {error}"
                        if (gitShouldFail) {
                            assert.ok(errorMessage.includes('Git configuration') || 
                                     errorMessage.includes('git configuration'),
                                'Error message should mention Git configuration failure');
                        }
                        if (vscodeShouldFail) {
                            assert.ok(errorMessage.includes('VSCode configuration') || 
                                     errorMessage.includes('vscode configuration'),
                                'Error message should mention VSCode configuration failure');
                        }
                        if (npmShouldFail) {
                            assert.ok(errorMessage.includes('npm configuration'),
                                'Error message should mention npm configuration failure');
                        }
                    }
                }
            ),
            { numRuns: getPropertyTestRuns() }
        );
    });
});
