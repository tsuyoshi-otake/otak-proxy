/**
 * Unit tests for ProxyApplier
 * 
 * These tests verify the basic functionality of ProxyApplier:
 * - applyProxy method
 * - disableProxy method
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ProxyApplier } from '../core/ProxyApplier';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { I18nManager } from '../i18n/I18nManager';

function overrideWorkspaceTrustForTest(value: boolean): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'isTrusted');
    Object.defineProperty(vscode.workspace, 'isTrusted', {
        configurable: true,
        get: () => value
    });

    return () => {
        if (descriptor) {
            Object.defineProperty(vscode.workspace, 'isTrusted', descriptor);
        } else {
            delete (vscode.workspace as { isTrusted?: boolean }).isTrusted;
        }
    };
}

suite('ProxyApplier Unit Tests', () => {
    setup(() => {
        I18nManager.getInstance().initialize('en');
    });

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

    test('applyProxy reports progress when requested', async () => {
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

        const progressMessages: string[] = [];
        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {},
            showProgressNotification: async (_title: string, task: any) => task({
                report: ({ message }: { message?: string }) => {
                    if (message) {
                        progressMessages.push(message);
                    }
                }
            })
        } as any;

        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            new ProxyUrlValidator(),
            new InputSanitizer(),
            mockNotifier
        );

        const result = await applier.applyProxy('http://proxy.example.com:8080', true, { showProgress: true });

        assert.strictEqual(result, true);
        assert.ok(progressMessages.includes('Updating VS Code proxy settings...'));
        assert.ok(progressMessages.includes('Updating Git proxy settings...'));
        assert.ok(progressMessages.includes('Updating npm proxy settings...'));
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

    test('disableProxy marks tracked proxy targets as not configured after successful unset', async () => {
        let state = {
            mode: 'auto',
            gitConfigured: true,
            vscodeConfigured: true,
            npmConfigured: true
        };
        const stateManager = {
            getState: async () => ({ ...state }),
            saveState: async (nextState: typeof state) => {
                state = { ...nextState };
            }
        } as any;

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

        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;

        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            new ProxyUrlValidator(),
            new InputSanitizer(),
            mockNotifier,
            stateManager
        );

        const result = await applier.disableProxy();

        assert.strictEqual(result, true);
        assert.strictEqual(state.gitConfigured, false);
        assert.strictEqual(state.vscodeConfigured, false);
        assert.strictEqual(state.npmConfigured, false);
    });

    test('applyProxy invokes optional pip manager and tracks successful pip configuration', async () => {
        let state: any = {
            mode: 'auto',
            gitConfigured: false,
            vscodeConfigured: false,
            npmConfigured: false,
            pipConfigured: undefined
        };
        const stateManager = {
            getState: async () => ({ ...state }),
            saveState: async (nextState: any) => {
                state = { ...nextState };
            }
        } as any;

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

        let pipSetCalls = 0;
        const mockPipManager = {
            setProxy: async () => {
                pipSetCalls++;
                return { success: true };
            },
            unsetProxy: async () => ({ success: true })
        } as any;

        const mockNotifier = {
            showSuccess: () => {},
            showError: () => {},
            showWarning: () => {}
        } as any;

        const applier = new ProxyApplier(
            mockGitManager,
            mockVscodeManager,
            mockNpmManager,
            new ProxyUrlValidator(),
            new InputSanitizer(),
            mockNotifier,
            stateManager,
            undefined,
            mockPipManager
        );

        const result = await applier.applyProxyDetailed('http://proxy.example.com:8080', true);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.results.pipSuccess, true);
        assert.strictEqual(pipSetCalls, 1);
        assert.strictEqual(state.pipConfigured, true);
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

    test('applyProxy does not change settings in an untrusted workspace', async () => {
        const restoreWorkspaceTrust = overrideWorkspaceTrustForTest(false);

        try {
            let setCalls = 0;
            let warningShown = false;

            const mockGitManager = {
                setProxy: async () => {
                    setCalls++;
                    return { success: true };
                },
                unsetProxy: async () => ({ success: true })
            } as any;

            const mockVscodeManager = {
                setProxy: async () => {
                    setCalls++;
                    return { success: true };
                },
                unsetProxy: async () => ({ success: true })
            } as any;

            const mockNpmManager = {
                setProxy: async () => {
                    setCalls++;
                    return { success: true };
                },
                unsetProxy: async () => ({ success: true })
            } as any;

            const mockNotifier = {
                showSuccess: () => {},
                showError: () => {},
                showWarning: () => { warningShown = true; }
            } as any;

            const applier = new ProxyApplier(
                mockGitManager,
                mockVscodeManager,
                mockNpmManager,
                new ProxyUrlValidator(),
                new InputSanitizer(),
                mockNotifier
            );

            const result = await applier.applyProxy('http://proxy.example.com:8080', true);

            assert.strictEqual(result, false, 'applyProxy should fail in untrusted workspace');
            assert.strictEqual(setCalls, 0, 'No manager should be called in untrusted workspace');
            assert.strictEqual(warningShown, true, 'Warning should be shown in untrusted workspace');
        } finally {
            restoreWorkspaceTrust();
        }
    });

    test('disableProxy does not change settings in an untrusted workspace', async () => {
        const restoreWorkspaceTrust = overrideWorkspaceTrustForTest(false);

        try {
            let unsetCalls = 0;

            const mockGitManager = {
                setProxy: async () => ({ success: true }),
                unsetProxy: async () => {
                    unsetCalls++;
                    return { success: true };
                }
            } as any;

            const mockVscodeManager = {
                setProxy: async () => ({ success: true }),
                unsetProxy: async () => {
                    unsetCalls++;
                    return { success: true };
                }
            } as any;

            const mockNpmManager = {
                setProxy: async () => ({ success: true }),
                unsetProxy: async () => {
                    unsetCalls++;
                    return { success: true };
                }
            } as any;

            const mockNotifier = {
                showSuccess: () => {},
                showError: () => {},
                showWarning: () => {}
            } as any;

            const applier = new ProxyApplier(
                mockGitManager,
                mockVscodeManager,
                mockNpmManager,
                new ProxyUrlValidator(),
                new InputSanitizer(),
                mockNotifier
            );

            const result = await applier.disableProxy();

            assert.strictEqual(result, false, 'disableProxy should fail in untrusted workspace');
            assert.strictEqual(unsetCalls, 0, 'No manager should be called in untrusted workspace');
        } finally {
            restoreWorkspaceTrust();
        }
    });
});
