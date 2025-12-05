import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyUrlValidator } from '../validation/ProxyUrlValidator';
import { InputSanitizer } from '../validation/InputSanitizer';
import { GitConfigManager } from '../config/GitConfigManager';
import { VscodeConfigManager } from '../config/VscodeConfigManager';
import { NpmConfigManager } from '../config/NpmConfigManager';
import { SystemProxyDetector } from '../config/SystemProxyDetector';
import { ErrorAggregator } from '../errors/ErrorAggregator';
import { UserNotifier } from '../errors/UserNotifier';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Integration Test Suite
 * 
 * Tests complete workflows across multiple components:
 * - setProxy flow: validation -> Git config -> VSCode config
 * - detectProxy flow: system detection -> validation -> application
 * - disableProxy flow: Git unset -> VSCode unset -> error handling
 * - error recovery: partial failures -> error aggregation -> user notification
 * 
 * Requirements: All (comprehensive integration testing)
 */
/**
 * Helper function to check if npm is available
 */
async function isNpmAvailable(): Promise<boolean> {
    try {
        await execFileAsync('npm', ['--version'], {
            timeout: 5000,
            encoding: 'utf8'
        });
        return true;
    } catch {
        return false;
    }
}

suite('Integration Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let validator: ProxyUrlValidator;
    let sanitizer: InputSanitizer;
    let gitConfigManager: GitConfigManager;
    let vscodeConfigManager: VscodeConfigManager;
    let npmConfigManager: NpmConfigManager;
    let systemProxyDetector: SystemProxyDetector;
    let errorAggregator: ErrorAggregator;
    let userNotifier: UserNotifier;
    let npmAvailable: boolean;

    suiteSetup(async () => {
        npmAvailable = await isNpmAvailable();
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        validator = new ProxyUrlValidator();
        sanitizer = new InputSanitizer();
        gitConfigManager = new GitConfigManager();
        vscodeConfigManager = new VscodeConfigManager();
        npmConfigManager = new NpmConfigManager();
        systemProxyDetector = new SystemProxyDetector();
        errorAggregator = new ErrorAggregator();
        userNotifier = new UserNotifier();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Integration Test 1: Complete setProxy Flow
     * 
     * Tests the complete flow of setting a proxy:
     * 1. User provides proxy URL
     * 2. Validation layer checks URL format and security
     * 3. Git configuration is updated
     * 4. VSCode configuration is updated
     * 5. Success notification is shown with sanitized URL
     * 
     * This test verifies that all components work together correctly
     * and that credentials are properly sanitized in user-facing messages.
     */
    suite('Complete setProxy Flow', () => {
        test('should successfully set proxy with valid URL', async () => {
            const testUrl = 'http://proxy.example.com:8080';
            
            // Step 1: Validate URL
            const validationResult = validator.validate(testUrl);
            assert.strictEqual(validationResult.isValid, true, 'URL should be valid');
            assert.strictEqual(validationResult.errors.length, 0, 'Should have no validation errors');
            
            // Step 2: Set Git proxy
            const gitResult = await gitConfigManager.setProxy(testUrl);
            assert.strictEqual(gitResult.success, true, 'Git configuration should succeed');
            
            // Step 3: Verify Git proxy was set
            const gitProxy = await gitConfigManager.getProxy();
            assert.strictEqual(gitProxy, testUrl, 'Git proxy should match the set URL');
            
            // Step 4: Set VSCode proxy (mocked)
            const vscodeSetStub = sandbox.stub(vscodeConfigManager, 'setProxy').resolves({ success: true });
            const vscodeResult = await vscodeConfigManager.setProxy(testUrl);
            assert.strictEqual(vscodeResult.success, true, 'VSCode configuration should succeed');
            assert.strictEqual(vscodeSetStub.calledOnce, true, 'VSCode setProxy should be called once');
            
            // Step 5: Verify sanitization for display
            const sanitizedUrl = sanitizer.maskPassword(testUrl);
            // URL.toString() may add trailing slash, so we normalize for comparison
            const normalizedSanitized = sanitizedUrl.replace(/\/$/, '');
            const normalizedTest = testUrl.replace(/\/$/, '');
            assert.strictEqual(normalizedSanitized, normalizedTest, 'URL without credentials should remain unchanged');
            
            // Cleanup
            await gitConfigManager.unsetProxy();
        });

        test('should handle proxy URL with credentials', async () => {
            const testUrl = 'http://user:password@proxy.example.com:8080';
            const expectedSanitized = 'http://user:****@proxy.example.com:8080';
            
            // Step 1: Validate URL with credentials
            const validationResult = validator.validate(testUrl);
            assert.strictEqual(validationResult.isValid, true, 'URL with credentials should be valid');
            
            // Step 2: Set Git proxy
            const gitResult = await gitConfigManager.setProxy(testUrl);
            assert.strictEqual(gitResult.success, true, 'Git configuration should succeed');
            
            // Step 3: Verify sanitization masks password
            const sanitizedUrl = sanitizer.maskPassword(testUrl);
            // URL.toString() may add trailing slash, so we normalize for comparison
            const normalizedSanitized = sanitizedUrl.replace(/\/$/, '');
            const normalizedExpected = expectedSanitized.replace(/\/$/, '');
            assert.strictEqual(normalizedSanitized, normalizedExpected, 'Password should be masked');
            assert.strictEqual(sanitizedUrl.includes('password'), false, 'Sanitized URL should not contain password');
            
            // Cleanup
            await gitConfigManager.unsetProxy();
        });

        test('should reject invalid URL before configuration', async () => {
            const invalidUrl = 'http://proxy.com; rm -rf /';
            
            // Step 1: Validation should fail
            const validationResult = validator.validate(invalidUrl);
            assert.strictEqual(validationResult.isValid, false, 'URL with shell metacharacters should be invalid');
            assert.ok(validationResult.errors.length > 0, 'Should have validation errors');
            
            // Step 2: Configuration should not proceed
            // In real implementation, this would be prevented by the validation layer
            // Here we verify that the validator correctly identifies the issue
            assert.ok(
                validationResult.errors.some(err => err.includes('shell metacharacters')),
                'Error should mention shell metacharacters'
            );
        });
    });

    /**
     * Integration Test 2: detectProxy Flow
     * 
     * Tests the system proxy detection flow:
     * 1. System proxy is detected from OS/environment
     * 2. Detected proxy is validated
     * 3. Valid proxy is returned for application
     * 4. Invalid proxy is rejected with appropriate error
     * 
     * This test verifies that system detection integrates with validation
     * and handles both valid and invalid detected proxies correctly.
     */
    suite('detectProxy Flow', () => {
        test('should detect and validate system proxy', async () => {
            // Mock environment variable
            const testProxy = 'http://corporate-proxy.example.com:8080';
            const originalEnv = process.env.HTTP_PROXY;
            process.env.HTTP_PROXY = testProxy;
            
            try {
                // Step 1: Detect system proxy
                const detectedProxy = await systemProxyDetector.detectSystemProxy();
                
                // Step 2: Verify detection succeeded
                assert.ok(detectedProxy !== null, 'Should detect proxy from environment');
                assert.strictEqual(detectedProxy, testProxy, 'Detected proxy should match environment variable');
                
                // Step 3: Validate detected proxy
                const validationResult = validator.validate(detectedProxy!);
                assert.strictEqual(validationResult.isValid, true, 'Detected proxy should be valid');
            } finally {
                // Restore environment
                if (originalEnv) {
                    process.env.HTTP_PROXY = originalEnv;
                } else {
                    delete process.env.HTTP_PROXY;
                }
            }
        });

        test('should reject invalid detected proxy', async () => {
            // Mock environment with invalid proxy
            const invalidProxy = 'http://proxy.com; malicious-command';
            const originalEnv = process.env.HTTP_PROXY;
            process.env.HTTP_PROXY = invalidProxy;
            
            try {
                // Step 1: Detect system proxy
                const detectedProxy = await systemProxyDetector.detectSystemProxy();
                
                // Step 2: Detection should return null for invalid proxy
                // SystemProxyDetector validates internally and returns null for invalid proxies
                assert.strictEqual(detectedProxy, null, 'Should reject invalid detected proxy');
            } finally {
                // Restore environment
                if (originalEnv) {
                    process.env.HTTP_PROXY = originalEnv;
                } else {
                    delete process.env.HTTP_PROXY;
                }
            }
        });

        test('should handle detection failure gracefully', async () => {
            // Clear all proxy environment variables
            const originalHttpProxy = process.env.HTTP_PROXY;
            const originalHttpsProxy = process.env.HTTPS_PROXY;
            const originalHttpProxyLower = process.env.http_proxy;
            const originalHttpsProxyLower = process.env.https_proxy;
            
            delete process.env.HTTP_PROXY;
            delete process.env.HTTPS_PROXY;
            delete process.env.http_proxy;
            delete process.env.https_proxy;
            
            try {
                // Step 1: Attempt detection with no proxy configured
                const detectedProxy = await systemProxyDetector.detectSystemProxy();
                
                // Step 2: Should return null gracefully (not throw)
                assert.strictEqual(detectedProxy, null, 'Should return null when no proxy is detected');
            } finally {
                // Restore environment
                if (originalHttpProxy) {
                    process.env.HTTP_PROXY = originalHttpProxy;
                }
                if (originalHttpsProxy) {
                    process.env.HTTPS_PROXY = originalHttpsProxy;
                }
                if (originalHttpProxyLower) {
                    process.env.http_proxy = originalHttpProxyLower;
                }
                if (originalHttpsProxyLower) {
                    process.env.https_proxy = originalHttpsProxyLower;
                }
            }
        });
    });

    /**
     * Integration Test 3: disableProxy Flow
     * 
     * Tests the proxy disabling flow:
     * 1. Git proxy configuration is removed
     * 2. VSCode proxy configuration is removed
     * 3. Success is reported even if some operations fail
     * 4. Errors are aggregated and reported to user
     * 
     * This test verifies that disabling works correctly and handles
     * partial failures gracefully.
     */
    suite('disableProxy Flow', () => {
        test('should successfully disable proxy', async () => {
            // Setup: First set a proxy
            const testUrl = 'http://proxy.example.com:8080';
            await gitConfigManager.setProxy(testUrl);
            
            // Step 1: Unset Git proxy
            const gitResult = await gitConfigManager.unsetProxy();
            assert.strictEqual(gitResult.success, true, 'Git unset should succeed');
            
            // Step 2: Verify Git proxy was removed
            const gitProxy = await gitConfigManager.getProxy();
            assert.strictEqual(gitProxy, null, 'Git proxy should be null after unset');
            
            // Step 3: Unset VSCode proxy (mocked)
            const vscodeUnsetStub = sandbox.stub(vscodeConfigManager, 'unsetProxy').resolves({ success: true });
            const vscodeResult = await vscodeConfigManager.unsetProxy();
            assert.strictEqual(vscodeResult.success, true, 'VSCode unset should succeed');
            assert.strictEqual(vscodeUnsetStub.calledOnce, true, 'VSCode unsetProxy should be called once');
        });

        test('should handle unset when no proxy is configured', async () => {
            // Ensure no proxy is set
            await gitConfigManager.unsetProxy();
            
            // Step 1: Unset when already unset
            const gitResult = await gitConfigManager.unsetProxy();
            assert.strictEqual(gitResult.success, true, 'Unset should succeed even when no proxy is configured');
            
            // Step 2: Verify still no proxy
            const gitProxy = await gitConfigManager.getProxy();
            assert.strictEqual(gitProxy, null, 'Git proxy should remain null');
        });
    });

    /**
     * Integration Test 4: Error Recovery Scenarios
     * 
     * Tests error handling across multiple components:
     * 1. Partial failures (Git succeeds, VSCode fails)
     * 2. Error aggregation collects all errors
     * 3. User receives comprehensive error message
     * 4. System continues operating despite errors
     * 
     * This test verifies that the error handling layer works correctly
     * and provides useful feedback to users.
     */
    suite('Error Recovery Scenarios', () => {
        test('should aggregate errors from multiple operations', async () => {
            const errorAgg = new ErrorAggregator();
            
            // Step 1: Add multiple errors
            errorAgg.addError('Git configuration', 'Git is not installed');
            errorAgg.addError('VSCode configuration', 'Failed to write settings');
            
            // Step 2: Verify errors are collected
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have errors');
            
            // Step 3: Format errors for display
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('Git configuration'), 'Should include Git error');
            assert.ok(formattedErrors.includes('VSCode configuration'), 'Should include VSCode error');
            assert.ok(formattedErrors.includes('Git is not installed'), 'Should include Git error details');
            assert.ok(formattedErrors.includes('Failed to write settings'), 'Should include VSCode error details');
        });

        test('should handle partial success in setProxy', async () => {
            const testUrl = 'http://proxy.example.com:8080';
            const errorAgg = new ErrorAggregator();
            
            // Step 1: Git configuration succeeds
            const gitResult = await gitConfigManager.setProxy(testUrl);
            if (!gitResult.success) {
                errorAgg.addError('Git configuration', gitResult.error || 'Unknown error');
            }
            assert.strictEqual(gitResult.success, true, 'Git should succeed');
            
            // Step 2: VSCode configuration fails (mocked)
            const vscodeSetStub = sandbox.stub(vscodeConfigManager, 'setProxy').resolves({
                success: false,
                error: 'Failed to write VSCode settings',
                errorType: 'CONFIG_WRITE_FAILED' as const
            });
            
            const vscodeResult = await vscodeConfigManager.setProxy(testUrl);
            if (!vscodeResult.success) {
                errorAgg.addError('VSCode configuration', vscodeResult.error || 'Unknown error');
            }
            assert.strictEqual(vscodeResult.success, false, 'VSCode should fail');
            
            // Step 3: Verify error aggregation
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have errors from VSCode failure');
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('VSCode configuration'), 'Should include VSCode error');
            
            // Cleanup
            await gitConfigManager.unsetProxy();
        });

        test('should handle Git not installed error', async () => {
            // This test verifies error type detection
            // We can't actually uninstall Git, so we test the error handling logic
            
            const errorAgg = new ErrorAggregator();
            
            // Simulate Git not installed error
            errorAgg.addError('Git configuration', 'Git is not installed or not in PATH');
            
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have error');
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('Git is not installed'), 'Should include Git not installed message');
        });

        test('should handle validation errors before configuration', async () => {
            const invalidUrl = 'not-a-valid-url';
            const errorAgg = new ErrorAggregator();
            
            // Step 1: Validation fails
            const validationResult = validator.validate(invalidUrl);
            assert.strictEqual(validationResult.isValid, false, 'Validation should fail');
            
            // Step 2: Collect validation errors
            if (!validationResult.isValid) {
                validationResult.errors.forEach(error => {
                    errorAgg.addError('Validation', error);
                });
            }
            
            // Step 3: Verify errors are collected
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have validation errors');
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('Validation'), 'Should include validation errors');
        });

        test('should clear errors after reporting', async () => {
            const errorAgg = new ErrorAggregator();
            
            // Add errors
            errorAgg.addError('Test operation', 'Test error');
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have errors');
            
            // Clear errors
            errorAgg.clear();
            assert.strictEqual(errorAgg.hasErrors(), false, 'Should have no errors after clear');
        });
    });

    /**
     * Integration Test 5: End-to-End Workflow
     * 
     * Tests a complete user workflow:
     * 1. User enters proxy URL
     * 2. System validates and configures
     * 3. User disables proxy
     * 4. System cleans up configuration
     * 
     * This test simulates a real user interaction with the extension.
     */
    suite('End-to-End Workflow', () => {
        test('should handle complete user workflow', async () => {
            const testUrl = 'http://user:pass@proxy.example.com:8080';
            const errorAgg = new ErrorAggregator();
            
            // Step 1: User provides URL
            // Step 2: Validate URL
            const validationResult = validator.validate(testUrl);
            assert.strictEqual(validationResult.isValid, true, 'URL should be valid');
            
            // Step 3: Configure Git
            const gitSetResult = await gitConfigManager.setProxy(testUrl);
            if (!gitSetResult.success) {
                errorAgg.addError('Git configuration', gitSetResult.error || 'Unknown error');
            }
            assert.strictEqual(gitSetResult.success, true, 'Git configuration should succeed');
            
            // Step 4: Configure VSCode (mocked)
            const vscodeSetStub = sandbox.stub(vscodeConfigManager, 'setProxy').resolves({ success: true });
            const vscodeSetResult = await vscodeConfigManager.setProxy(testUrl);
            if (!vscodeSetResult.success) {
                errorAgg.addError('VSCode configuration', vscodeSetResult.error || 'Unknown error');
            }
            assert.strictEqual(vscodeSetResult.success, true, 'VSCode configuration should succeed');
            
            // Step 5: Verify configuration
            const gitProxy = await gitConfigManager.getProxy();
            assert.strictEqual(gitProxy, testUrl, 'Git proxy should be set');
            
            // Step 6: Sanitize for display
            const sanitizedUrl = sanitizer.maskPassword(testUrl);
            assert.strictEqual(sanitizedUrl.includes('pass'), false, 'Password should be masked');
            assert.ok(sanitizedUrl.includes('****'), 'Should contain mask characters');
            
            // Step 7: User disables proxy
            const gitUnsetResult = await gitConfigManager.unsetProxy();
            assert.strictEqual(gitUnsetResult.success, true, 'Git unset should succeed');
            
            const vscodeUnsetStub = sandbox.stub(vscodeConfigManager, 'unsetProxy').resolves({ success: true });
            const vscodeUnsetResult = await vscodeConfigManager.unsetProxy();
            assert.strictEqual(vscodeUnsetResult.success, true, 'VSCode unset should succeed');
            
            // Step 8: Verify cleanup
            const finalGitProxy = await gitConfigManager.getProxy();
            assert.strictEqual(finalGitProxy, null, 'Git proxy should be removed');
            
            // Step 9: Verify no errors occurred
            assert.strictEqual(errorAgg.hasErrors(), false, 'Should have no errors in successful workflow');
        });
    });

    /**
     * Integration Test 6: npm Configuration Integration
     *
     * Tests npm proxy configuration as part of the complete workflow:
     * 1. npm proxy is set alongside Git and VSCode
     * 2. npm errors are isolated from other configurations
     * 3. npm unset works correctly
     * 4. npm errors are properly aggregated
     *
     * Requirements: 1.1, 1.2, 1.3, 2.1, 2.3, 5.1, 5.3
     */
    suite('npm Configuration Integration', () => {
        test('should set npm proxy alongside Git', async function() {
            if (!npmAvailable) {
                this.skip();
                return;
            }

            const testUrl = 'http://proxy.example.com:8080';
            const errorAgg = new ErrorAggregator();

            try {
                // Step 1: Validate URL
                const validationResult = validator.validate(testUrl);
                assert.strictEqual(validationResult.isValid, true, 'URL should be valid');

                // Step 2: Configure Git
                const gitResult = await gitConfigManager.setProxy(testUrl);
                if (!gitResult.success) {
                    errorAgg.addError('Git configuration', gitResult.error || 'Unknown error');
                }

                // Step 3: Configure npm
                const npmResult = await npmConfigManager.setProxy(testUrl);
                if (!npmResult.success) {
                    errorAgg.addError('npm configuration', npmResult.error || 'Unknown error');
                }
                assert.strictEqual(npmResult.success, true, `npm configuration should succeed: ${npmResult.error}`);

                // Step 4: Verify npm proxy was set
                const npmProxy = await npmConfigManager.getProxy();
                assert.strictEqual(npmProxy, testUrl, 'npm proxy should match the set URL');

                // Step 5: Verify no errors occurred
                assert.strictEqual(errorAgg.hasErrors(), false, 'Should have no errors');
            } finally {
                // Cleanup
                await gitConfigManager.unsetProxy();
                await npmConfigManager.unsetProxy();
            }
        });

        test('should handle npm error isolation', async function() {
            // This test verifies that npm errors are captured separately
            // and don't affect Git/VSCode operations

            const testUrl = 'http://proxy.example.com:8080';
            const errorAgg = new ErrorAggregator();

            // Step 1: Configure Git (should succeed)
            const gitResult = await gitConfigManager.setProxy(testUrl);
            if (!gitResult.success) {
                errorAgg.addError('Git configuration', gitResult.error || 'Unknown error');
            }

            // Step 2: Simulate npm failure
            errorAgg.addError('npm configuration', 'npm is not installed or not in PATH');

            // Step 3: Verify Git succeeded despite npm error
            if (gitResult.success) {
                const gitProxy = await gitConfigManager.getProxy();
                assert.strictEqual(gitProxy, testUrl, 'Git proxy should be set despite npm error');
            }

            // Step 4: Verify error aggregation includes npm error
            assert.strictEqual(errorAgg.hasErrors(), true, 'Should have npm error');
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('npm configuration'), 'Should include npm error');
            assert.ok(formattedErrors.includes('not installed'), 'Should include npm error details');

            // Cleanup
            await gitConfigManager.unsetProxy();
        });

        test('should unset npm proxy correctly', async function() {
            if (!npmAvailable) {
                this.skip();
                return;
            }

            const testUrl = 'http://proxy.example.com:8080';

            try {
                // Step 1: Set npm proxy
                const setResult = await npmConfigManager.setProxy(testUrl);
                assert.strictEqual(setResult.success, true, `npm set should succeed: ${setResult.error}`);

                // Step 2: Verify proxy is set
                const npmProxy = await npmConfigManager.getProxy();
                assert.strictEqual(npmProxy, testUrl, 'npm proxy should be set');

                // Step 3: Unset npm proxy
                const unsetResult = await npmConfigManager.unsetProxy();
                assert.strictEqual(unsetResult.success, true, `npm unset should succeed: ${unsetResult.error}`);

                // Step 4: Verify proxy is removed
                const finalProxy = await npmConfigManager.getProxy();
                assert.strictEqual(finalProxy, null, 'npm proxy should be null after unset');
            } finally {
                // Ensure cleanup
                await npmConfigManager.unsetProxy();
            }
        });

        test('should include npm suggestions in error output', async function() {
            const errorAgg = new ErrorAggregator();

            // Add npm-specific error
            errorAgg.addError('npm configuration', 'npm is not installed or not in PATH');

            // Verify suggestions are generated
            const formattedErrors = errorAgg.formatErrors();
            assert.ok(formattedErrors.includes('Suggestions:'), 'Should include suggestions');
            assert.ok(
                formattedErrors.includes('nodejs.org') || formattedErrors.includes('npm'),
                'Should include npm-related suggestions'
            );
        });

        test('should handle complete workflow with npm, Git, and VSCode', async function() {
            if (!npmAvailable) {
                this.skip();
                return;
            }

            const testUrl = 'http://user:pass@proxy.example.com:8080';
            const errorAgg = new ErrorAggregator();

            try {
                // Step 1: Validate URL
                const validationResult = validator.validate(testUrl);
                assert.strictEqual(validationResult.isValid, true, 'URL should be valid');

                // Step 2: Configure all managers
                const gitResult = await gitConfigManager.setProxy(testUrl);
                if (!gitResult.success) {
                    errorAgg.addError('Git configuration', gitResult.error || 'Unknown error');
                }

                const vscodeSetStub = sandbox.stub(vscodeConfigManager, 'setProxy').resolves({ success: true });
                const vscodeResult = await vscodeConfigManager.setProxy(testUrl);
                if (!vscodeResult.success) {
                    errorAgg.addError('VSCode configuration', vscodeResult.error || 'Unknown error');
                }

                const npmResult = await npmConfigManager.setProxy(testUrl);
                if (!npmResult.success) {
                    errorAgg.addError('npm configuration', npmResult.error || 'Unknown error');
                }

                // Step 3: Verify all configurations
                const gitProxy = await gitConfigManager.getProxy();
                const npmProxy = await npmConfigManager.getProxy();

                assert.strictEqual(gitProxy, testUrl, 'Git proxy should be set');
                assert.strictEqual(npmProxy, testUrl, 'npm proxy should be set');

                // Step 4: Sanitize for display
                const sanitizedUrl = sanitizer.maskPassword(testUrl);
                assert.strictEqual(sanitizedUrl.includes('pass'), false, 'Password should be masked');

                // Step 5: Disable all proxies
                await gitConfigManager.unsetProxy();
                const vscodeUnsetStub = sandbox.stub(vscodeConfigManager, 'unsetProxy').resolves({ success: true });
                await vscodeConfigManager.unsetProxy();
                await npmConfigManager.unsetProxy();

                // Step 6: Verify all proxies are removed
                const finalGitProxy = await gitConfigManager.getProxy();
                const finalNpmProxy = await npmConfigManager.getProxy();

                assert.strictEqual(finalGitProxy, null, 'Git proxy should be removed');
                assert.strictEqual(finalNpmProxy, null, 'npm proxy should be removed');

                // Step 7: Verify no errors
                assert.strictEqual(errorAgg.hasErrors(), false, 'Should have no errors');
            } finally {
                // Cleanup
                await gitConfigManager.unsetProxy();
                await npmConfigManager.unsetProxy();
            }
        });
    });
});
