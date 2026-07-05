import * as assert from 'assert';
import { formatDiagnosticsNotification, shouldShowDiagnosticsNotification } from '../../commands/DiagnoseProxyCommand';
import { ProxyIssue } from '../../core/v3Types';
import { I18nManager } from '../../i18n/I18nManager';

suite('DiagnoseProxyCommand Unit Tests', () => {
    suiteSetup(() => {
        // The notification is now localized (issue #13); pin English so these
        // assertions check the English rendering deterministically.
        I18nManager.getInstance().initialize('en');
    });

    function issue(id: string, targetId: string, category: ProxyIssue['category'] = 'applyFailed'): ProxyIssue {
        return {
            id,
            fingerprint: `${id}:${targetId}:test`,
            category,
            impact: category === 'capabilityUnavailable' ? 'informational' : 'blocksConvergence',
            targetId,
            targetHost: targetId === 'windows' ? 'unavailable' : 'workspaceHost',
            source: 'test',
            capability: 'readOnly',
            autoAction: 'none',
            userAction: 'showDetails',
            evidence: {}
        };
    }

    function existingTerminalAdvisory(): ProxyIssue {
        return {
            id: 'terminal.existingTerminals',
            fingerprint: 'terminal.existingTerminals:test',
            category: 'needsNewTerminal',
            impact: 'advisoryResidualRisk',
            targetId: 'terminal.existing',
            targetHost: 'workspaceHost',
            source: 'vscode.window.terminals',
            capability: 'readOnly',
            autoAction: 'none',
            userAction: 'openNewTerminal',
            evidence: { terminalCount: 1 }
        };
    }

    test('shows no-issue completion clearly', () => {
        const message = formatDiagnosticsNotification({ issueCount: 0, issues: [] });

        assert.strictEqual(message, 'Proxy diagnostics completed: no issues found.');
    });

    test('includes the problem target and residual reason', () => {
        const message = formatDiagnosticsNotification({
            issueCount: 1,
            issues: [issue('git.managedProxyResidual', 'git.global.proxy')]
        });

        assert.ok(message.includes('Proxy diagnostics found 1 issue'));
        assert.ok(message.includes('Git global proxy'));
        assert.ok(message.includes('proxy should be disabled'));
        assert.ok(message.includes('still configured'));
    });

    test('includes mismatch reason and extra issue count', () => {
        const message = formatDiagnosticsNotification({
            issueCount: 3,
            issues: [
                issue('npm.managedProxyMismatch', 'npm.user.proxy'),
                issue('git.managedProxyResidual', 'git.global.proxy'),
                issue('vscode.managedProxyResidual', 'vscode.http.proxy')
            ]
        });

        assert.ok(message.includes('Proxy diagnostics found 3 issues'));
        assert.ok(message.includes('npm user proxy'));
        assert.ok(message.includes('does not match the expected active proxy'));
        assert.ok(message.includes('(+2 more)'));
    });

    test('suppresses notifications when existing terminal advisory is the only issue', () => {
        const report = {
            issueCount: 1,
            issues: [existingTerminalAdvisory()]
        };

        assert.strictEqual(shouldShowDiagnosticsNotification(report), false);
    });

    test('excludes existing terminal advisory from notification issue count when actionable issues exist', () => {
        const message = formatDiagnosticsNotification({
            issueCount: 2,
            issues: [
                existingTerminalAdvisory(),
                issue('git.managedProxyResidual', 'git.global.proxy')
            ]
        });

        assert.strictEqual(shouldShowDiagnosticsNotification({
            issueCount: 2,
            issues: [
                existingTerminalAdvisory(),
                issue('git.managedProxyResidual', 'git.global.proxy')
            ]
        }), true);
        assert.ok(message.includes('Proxy diagnostics found 1 issue'));
        assert.ok(message.includes('Git global proxy'));
        assert.ok(!message.includes('existing terminals'));
    });

    test('explains diagnostics capability issues', () => {
        const message = formatDiagnosticsNotification({
            issueCount: 1,
            issues: [
                issue(
                    'diagnostics.childProcess.unavailable',
                    'diagnostics.childProcess',
                    'capabilityUnavailable'
                )
            ]
        });

        assert.ok(message.includes('Git/npm diagnostics'));
        assert.ok(message.includes('could not be inspected'));
    });
});
