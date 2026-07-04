import * as assert from 'assert';
import { formatDiagnosticsNotification } from '../../commands/DiagnoseProxyCommand';
import { ProxyIssue } from '../../core/v3Types';

suite('DiagnoseProxyCommand Unit Tests', () => {
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
