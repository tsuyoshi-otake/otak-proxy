import * as assert from 'assert';
import { ProxyApplyDetailedResult } from '../../core/ProxyApplierTypes';
import { ProxyIssue } from '../../core/v3Types';
import {
    buildRemediationOutcome,
    classifyStopReason,
    RemediationOutcomeInput
} from '../../remediation/RemediationOutcome';

/**
 * #78: one apply request maps to exactly one stop reason, and the recorded
 * outcome never copies error messages or observed values (they can carry
 * credential-bearing proxy URLs).
 */
suite('RemediationOutcome (#78)', () => {
    function applyResult(overrides: Partial<ProxyApplyDetailedResult> = {}): ProxyApplyDetailedResult {
        return {
            success: true,
            enabled: true,
            proxyUrl: 'http://alice:s3cr3t@proxy.example.com:8080',
            results: {
                gitSuccess: true,
                vscodeSuccess: true,
                npmSuccess: true,
                terminalEnvSuccess: true,
                gitOutcome: 'configured',
                vscodeOutcome: 'configured',
                npmOutcome: 'skippedUnavailable',
                terminalEnvOutcome: 'configured'
            },
            errors: [],
            ...overrides
        };
    }

    function blocker(id = 'git.managedProxyMismatch'): ProxyIssue {
        return {
            id,
            fingerprint: `${id}:test`,
            category: 'applyFailed',
            impact: 'blocksConvergence',
            targetId: 'git.global.proxy',
            targetHost: 'workspaceHost',
            expectedSanitized: 'http://proxy.example.com:8080',
            actualSanitized: 'http://bob:hunter2@stale.example.com:3128',
            source: 'test',
            capability: 'readOnly',
            autoAction: 'none',
            userAction: 'showDetails',
            evidence: { raw: 'http://bob:hunter2@stale.example.com:3128' }
        };
    }

    function advisory(): ProxyIssue {
        return { ...blocker('terminal.existingTerminals'), impact: 'advisoryResidualRisk' };
    }

    function input(overrides: Partial<RemediationOutcomeInput> = {}): RemediationOutcomeInput {
        return {
            attempt: 1,
            trigger: 'manual',
            finishedAt: 0,
            desiredEnabled: true,
            success: true,
            applyResult: applyResult(),
            observedIssues: [],
            retryAttempted: false,
            retrySuppressed: false,
            lockSkipped: false,
            consentDenied: false,
            retryableFailure: false,
            retryEnabled: true,
            ...overrides
        };
    }

    const failed = applyResult({
        success: false,
        errors: [{ target: 'npm', message: 'npm ERR! http://alice:s3cr3t@proxy.example.com:8080', errorType: 'TIMEOUT' }]
    });

    test('successful writes with a clean observation are converged; without one, unverified', () => {
        assert.strictEqual(classifyStopReason(input()), 'converged');
        assert.strictEqual(classifyStopReason(input({ observedIssues: [advisory()] })), 'converged', 'advisories never block');
        assert.strictEqual(classifyStopReason(input({ observedIssues: undefined })), 'unverified');
    });

    test('pre-write stops win over everything observed after them', () => {
        const all = { lockSkipped: true, consentDenied: true, applyResult: applyResult({ superseded: true }) };
        assert.strictEqual(classifyStopReason(input(all)), 'consentRequired');
        assert.strictEqual(classifyStopReason(input({ ...all, consentDenied: false })), 'lockSkipped');
        assert.strictEqual(
            classifyStopReason(input({ applyResult: applyResult({ superseded: true }), observedIssues: [blocker()] })),
            'superseded'
        );
    });

    test('an unresolved request names how retry ended', () => {
        assert.strictEqual(classifyStopReason(input({ observedIssues: [blocker()], retryAttempted: true, retrySuppressed: true })), 'retryExhausted');
        assert.strictEqual(classifyStopReason(input({ applyResult: failed, retrySuppressed: true })), 'flapSuppressed');
        assert.strictEqual(classifyStopReason(input({ applyResult: failed, retryableFailure: true, retryEnabled: false })), 'retryDisabled');
        assert.strictEqual(classifyStopReason(input({ applyResult: failed, retryableFailure: false, retryEnabled: false })), 'notRetryable');
        assert.strictEqual(classifyStopReason(input({ observedIssues: [blocker()] })), 'notRetryable');
        assert.strictEqual(classifyStopReason(input({ applyResult: undefined })), 'notRetryable');
    });

    test('converged is an observation: undefined without diagnostics, false when superseded or blocked', () => {
        assert.strictEqual(buildRemediationOutcome(input()).converged, true);
        assert.strictEqual(buildRemediationOutcome(input({ observedIssues: undefined })).converged, undefined);
        assert.strictEqual(buildRemediationOutcome(input({ observedIssues: [blocker()] })).converged, false);
        assert.strictEqual(buildRemediationOutcome(input({ applyResult: applyResult({ superseded: true }) })).converged, false);
    });

    test('the outcome keeps targets, error types and blocker ids, and no secrets or observed values', () => {
        const outcome = buildRemediationOutcome(input({
            success: false,
            applyResult: applyResult({
                success: false,
                errors: [
                    ...failed.errors,
                    { target: 'git', message: 'second http://alice:s3cr3t@proxy.example.com:8080', errorType: 'TIMEOUT' }
                ]
            }),
            observedIssues: [blocker(), advisory()],
            retryAttempted: true
        }));

        assert.strictEqual(outcome.stopReason, 'retryExhausted');
        assert.deepStrictEqual(outcome.errorTypes, ['TIMEOUT']);
        assert.deepStrictEqual(outcome.remainingBlockerIds, ['git.managedProxyMismatch']);
        assert.deepStrictEqual(outcome.targetOutcomes, {
            git: 'configured',
            vscode: 'configured',
            npm: 'skippedUnavailable',
            terminalEnv: 'configured'
        });
        const serialized = JSON.stringify(outcome);
        for (const secret of ['s3cr3t', 'hunter2', 'alice', 'stale.example.com', 'npm ERR!']) {
            assert.ok(!serialized.includes(secret), `outcome must not contain ${secret}`);
        }
    });
});
