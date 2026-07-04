import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the configuration scope of v3 safety switches.
 *
 * Settings that enable/disable remediation behavior or tune how aggressively
 * the extension rewrites machine-level proxy config (git/npm/VS Code) must be
 * "machine" scoped. With "machine-overridable", a workspace .vscode/settings.json
 * (including one in an untrusted repository) could silently re-enable automatic
 * remediation or disable the cross-window apply lock against the user's choice.
 */
suite('V3 settings scope', () => {
    const SAFETY_CRITICAL_SETTINGS = [
        'otakProxy.diagnosticsEnabled',
        'otakProxy.automaticRemediationEnabled',
        'otakProxy.hostUserLockEnabled',
        'otakProxy.automaticRetryEnabled',
        'otakProxy.remediationDelayedRetryMs',
        'otakProxy.remediationFlapWindowMs',
        'otakProxy.remediationFlapMaxAttempts',
        'otakProxy.remediationFlapCooldownMs',
        'otakProxy.notificationCooldownMs',
        'otakProxy.slowDiagnosticsTtlMs',
        'otakProxy.terminalOffMaskingEnabled',
        'otakProxy.windowsActionsEnabled',
        'otakProxy.credentialTargetPolicy'
    ];

    function loadConfigurationProperties(): Record<string, { scope?: string }> {
        const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.contributes.configuration.properties;
    }

    test('remediation safety switches are machine scoped (not workspace-overridable)', () => {
        const properties = loadConfigurationProperties();

        for (const key of SAFETY_CRITICAL_SETTINGS) {
            const property = properties[key];
            assert.ok(property, `package.json must declare ${key}`);
            assert.strictEqual(
                property.scope,
                'machine',
                `${key} must use "machine" scope so workspace settings cannot override it`
            );
        }
    });
});
