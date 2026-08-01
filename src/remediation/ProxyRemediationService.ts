import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ProxyDiagnosticReport, ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { I18nManager } from '../i18n/I18nManager';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { publicFingerprint } from '../core/TargetOwnershipStore';
import { ProxyState } from '../core/types';
import { getHighestPriorityIssue, ProxyIssue } from '../core/v3Types';
import { readV3Settings, V3Settings } from '../core/V3Settings';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { hasProxyCredentials, removeProxyCredentials } from '../utils/ProxyStateSanitizer';
import { Logger } from '../utils/Logger';
import { ApplyLockRequest, ApplyLockService } from './ApplyLockService';
import { FlapTracker, FlapTrackerSettings } from './FlapTracker';

export type ProxyApplyTrigger =
    | 'manual'
    | 'startup'
    | 'sync'
    | 'autoDetection'
    | 'autoReachability';

export interface SafeProxyApplyOptions extends ProxyApplyOptions {
    trigger: ProxyApplyTrigger;
}

export type ProxyApplyDetailedDelegate = (
    proxyUrl: string,
    enabled: boolean,
    options?: ProxyApplyOptions
) => Promise<ProxyApplyDetailedResult>;

export interface ProxyRemediationServiceOptions {
    lockService?: ApplyLockService;
    flapTracker?: FlapTracker;
    diagnostics?: ProxyRuntimeDiagnostics;
    sleep?: (ms: number) => Promise<void>;
}

export interface SafeProxyApplyResult {
    success: boolean;
    applyResult?: ProxyApplyDetailedResult;
    diagnosticReport?: ProxyDiagnosticReport;
    retryAttempted: boolean;
    retrySuppressed: boolean;
    lockSkipped: boolean;
}

interface ConvergenceRetryResult {
    applyResult: ProxyApplyDetailedResult;
    diagnosticReport?: ProxyDiagnosticReport;
    retryAttempted: boolean;
    retrySuppressed: boolean;
}

const DEFAULT_LOCK_TTL_MS = 30000;
// Bounded wait for another window's convergence to finish before giving up on
// the apply lock (#30). Fixed schedule (not deadline-based) so tests can drive
// it deterministically with an injected sleep; sums to ~7.75s.
const LOCK_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 2000, 2000];
const CREDENTIAL_TARGET_CONSENT_KEY = 'otakProxy.v3.credentialTargetConsent';
const RETRYABLE_CONVERGENCE_ISSUE_IDS = new Set([
    'git.managedProxyResidual',
    'npm.managedProxyResidual',
    'vscode.managedProxyResidual',
    'git.managedProxyMismatch',
    'npm.managedProxyMismatch',
    'vscode.managedProxyMismatch'
]);
const RETRYABLE_APPLY_ERROR_TYPES = new Set(['TIMEOUT', 'LOCKED']);

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function flapSettings(settings: V3Settings): FlapTrackerSettings {
    return {
        windowMs: settings.flapWindowMs,
        maxAttempts: settings.flapMaxAttempts,
        cooldownMs: settings.flapCooldownMs,
        notificationCooldownMs: settings.notificationCooldownMs
    };
}

function isUserActionIssue(issue: ProxyIssue): boolean {
    return issue.impact === 'requiresUserDecision' ||
        issue.category === 'needsReload' ||
        issue.category === 'needsRestart' ||
        issue.category === 'needsWindowsPermission' ||
        issue.category === 'needsCredentialConsent';
}

export class ProxyRemediationService {
    private readonly lockService: ApplyLockService;
    private readonly flapTracker: FlapTracker;
    private readonly diagnostics: ProxyRuntimeDiagnostics;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly redactor = new ProxySecretRedactor();

    constructor(
        private readonly context: vscode.ExtensionContext,
        stateProvider: () => Promise<ProxyState>,
        options: ProxyRemediationServiceOptions = {}
    ) {
        this.lockService = options.lockService ?? new ApplyLockService();
        this.flapTracker = options.flapTracker ?? new FlapTracker(context.globalState);
        this.diagnostics = options.diagnostics ?? new ProxyRuntimeDiagnostics(context, stateProvider);
        this.sleep = options.sleep ?? defaultSleep;
    }

    async applyWithSafety(
        proxyUrl: string,
        enabled: boolean,
        options: SafeProxyApplyOptions,
        applyDetailed: ProxyApplyDetailedDelegate
    ): Promise<SafeProxyApplyResult> {
        const settings = readV3Settings();
        if (!(await this.ensureCredentialTargetConsent(proxyUrl, options, settings))) {
            const diagnosticReport = await this.runDiagnosticsIfEnabled(settings);
            return {
                success: false,
                diagnosticReport,
                retryAttempted: false,
                retrySuppressed: false,
                lockSkipped: false
            };
        }

        const targets = this.getWriteTargets();
        const task = async () => await this.applyInsideLocks(proxyUrl, enabled, options, applyDetailed, settings);

        if (!settings.hostUserLockEnabled) {
            return await task();
        }

        const lockResult = await this.lockService.withLocks(targets, DEFAULT_LOCK_TTL_MS, task, {
            retryDelaysMs: LOCK_RETRY_DELAYS_MS,
            sleep: this.sleep
        });
        if (lockResult.acquired) {
            return lockResult.value;
        }

        // Fresh diagnostics AFTER the bounded wait: by now the winning window
        // has normally finished converging, so a cached pre-wait report would
        // report stale divergence and re-trigger the very notification #30
        // removes.
        const diagnosticReport = await this.runDiagnosticsIfEnabled(settings, true);
        Logger.warn('Skipped proxy apply because another otak-proxy window still owns the apply lock after the bounded wait.');
        this.notifyAfterApply(() => this.notifyLockDivergenceIfNeeded(diagnosticReport, settings, options));
        return {
            success: false,
            diagnosticReport,
            retryAttempted: false,
            retrySuppressed: false,
            lockSkipped: true
        };
    }

    private async applyInsideLocks(
        proxyUrl: string,
        enabled: boolean,
        options: SafeProxyApplyOptions,
        applyDetailed: ProxyApplyDetailedDelegate,
        settings: V3Settings
    ): Promise<SafeProxyApplyResult> {
        let applyResult = await applyDetailed(proxyUrl, enabled, {
            silent: options.silent,
            showProgress: options.showProgress
        });
        let retryAttempted = false;
        let retrySuppressed = false;
        const fingerprint = this.applyFailureFingerprint(proxyUrl, enabled, applyResult);

        if (!applyResult.success && this.canRetry(settings, options, applyResult)) {
            const decision = await this.flapTracker.recordAttempt(fingerprint, flapSettings(settings));
            if (decision.allowed) {
                retryAttempted = true;
                await this.sleep(settings.delayedRetryMs);
                applyResult = await applyDetailed(proxyUrl, enabled, { silent: true });
            } else {
                retrySuppressed = true;
            }
        }

        // A failed apply may be a permanent configuration error. Reusing the
        // slow-diagnostics cache in that case avoids starting another batch of
        // external commands immediately after the failure. Successful applies
        // and actual retries still need a fresh convergence observation.
        const refreshDiagnostics = applyResult.success || retryAttempted;
        let diagnosticReport = await this.runDiagnosticsIfEnabled(settings, refreshDiagnostics);
        const convergenceRetry = await this.retryOnceForConvergenceIssue(
            proxyUrl,
            enabled,
            options,
            applyDetailed,
            settings,
            applyResult,
            diagnosticReport
        );
        if (convergenceRetry) {
            applyResult = convergenceRetry.applyResult;
            diagnosticReport = convergenceRetry.diagnosticReport;
            retryAttempted = retryAttempted || convergenceRetry.retryAttempted;
            retrySuppressed = retrySuppressed || convergenceRetry.retrySuppressed;
        }

        const convergenceIssue = this.getRetryableConvergenceIssue(diagnosticReport);
        const success = applyResult.success && !convergenceIssue;
        if (success) {
            await this.flapTracker.reset(fingerprint);
        } else if (!applyResult.success && (retryAttempted || retrySuppressed)) {
            const convergence = await this.flapTracker.recordNonConvergence(
                fingerprint,
                'externalOverride',
                flapSettings(settings)
            );
            retrySuppressed = retrySuppressed || convergence.escalated;
        }

        this.notifyAfterApply(() =>
            this.notifyDiagnosticsIfNeeded(diagnosticReport, settings, options, applyResult, retrySuppressed)
        );

        return {
            success,
            applyResult,
            diagnosticReport,
            retryAttempted,
            retrySuppressed,
            lockSkipped: false
        };
    }

    private notifyAfterApply(task: () => Promise<void>): void {
        void task().catch(error => {
            Logger.warn('Proxy remediation notification failed:', this.redactor.redactString(String(error)));
        });
    }

    private canRetry(
        settings: V3Settings,
        options: SafeProxyApplyOptions,
        applyResult: ProxyApplyDetailedResult
    ): boolean {
        return settings.automaticRemediationEnabled &&
            settings.automaticRetryEnabled &&
            applyResult.errors.some(error =>
                typeof error.errorType === 'string' &&
                RETRYABLE_APPLY_ERROR_TYPES.has(error.errorType)
            );
    }

    private async retryOnceForConvergenceIssue(
        proxyUrl: string,
        enabled: boolean,
        options: SafeProxyApplyOptions,
        applyDetailed: ProxyApplyDetailedDelegate,
        settings: V3Settings,
        applyResult: ProxyApplyDetailedResult,
        diagnosticReport: ProxyDiagnosticReport | undefined
    ): Promise<ConvergenceRetryResult | undefined> {
        const issue = this.getRetryableConvergenceIssue(diagnosticReport);
        if (!issue || !this.canRetryConvergence(settings, options, applyResult)) {
            return undefined;
        }

        const fingerprint = this.convergenceIssueFingerprint(proxyUrl, enabled, issue);
        const decision = await this.flapTracker.recordAttempt(fingerprint, flapSettings(settings));
        if (!decision.allowed) {
            return {
                applyResult,
                diagnosticReport,
                retryAttempted: false,
                retrySuppressed: true
            };
        }

        await this.sleep(settings.delayedRetryMs);
        const retriedApplyResult = await applyDetailed(proxyUrl, enabled, { silent: true });
        const retriedDiagnosticReport = await this.runDiagnosticsIfEnabled(settings, true);
        const remainingIssue = this.getRetryableConvergenceIssue(retriedDiagnosticReport);
        if (retriedApplyResult.success && !remainingIssue) {
            await this.flapTracker.reset(fingerprint);
            return {
                applyResult: retriedApplyResult,
                diagnosticReport: retriedDiagnosticReport,
                retryAttempted: true,
                retrySuppressed: false
            };
        }

        const convergence = await this.flapTracker.recordNonConvergence(
            fingerprint,
            remainingIssue?.category ?? 'applyFailed',
            flapSettings(settings)
        );
        return {
            applyResult: retriedApplyResult,
            diagnosticReport: retriedDiagnosticReport,
            retryAttempted: true,
            retrySuppressed: convergence.escalated
        };
    }

    private canRetryConvergence(
        settings: V3Settings,
        options: SafeProxyApplyOptions,
        applyResult: ProxyApplyDetailedResult
    ): boolean {
        return settings.automaticRemediationEnabled &&
            settings.automaticRetryEnabled &&
            applyResult.success;
    }

    private getRetryableConvergenceIssue(report: ProxyDiagnosticReport | undefined): ProxyIssue | undefined {
        return getHighestPriorityIssue(
            report?.issues.filter(issue =>
                issue.category === 'applyFailed' &&
                issue.impact === 'blocksConvergence' &&
                RETRYABLE_CONVERGENCE_ISSUE_IDS.has(issue.id)
            ) ?? []
        );
    }

    private async runDiagnosticsIfEnabled(settings: V3Settings, bypassSlowCache = false): Promise<ProxyDiagnosticReport | undefined> {
        if (!settings.diagnosticsEnabled) {
            return undefined;
        }

        try {
            return await this.diagnostics.run({ bypassSlowCache });
        } catch (error) {
            Logger.warn('Proxy diagnostics failed after apply:', this.redactor.redactString(String(error)));
            return undefined;
        }
    }

    private async notifyDiagnosticsIfNeeded(
        report: ProxyDiagnosticReport | undefined,
        settings: V3Settings,
        options: SafeProxyApplyOptions,
        applyResult: ProxyApplyDetailedResult,
        retrySuppressed: boolean
    ): Promise<void> {
        if (options.silent || settings.notificationLevel === 'off') {
            return;
        }

        const issue = report ? getHighestPriorityIssue(report.issues) : undefined;
        const shouldWarnForIssue = Boolean(issue && this.shouldNotifyForIssue(issue, settings));
        const shouldWarnForApply = !applyResult.success ||
            (retrySuppressed && shouldWarnForIssue);

        if (!shouldWarnForApply && !shouldWarnForIssue) {
            return;
        }

        const fingerprint = issue?.fingerprint ?? this.applyFailureFingerprint(applyResult.proxyUrl, applyResult.enabled, applyResult);
        if (!(await this.flapTracker.shouldNotify(fingerprint, flapSettings(settings)))) {
            return;
        }

        const i18n = I18nManager.getInstance();
        const message = !applyResult.success
            ? i18n.t('remediation.notification.applyFailed')
            : i18n.t('remediation.notification.issueDetected');
        const showDetails = i18n.t('action.showDetails');
        const userAction = issue ? this.actionLabelForIssue(issue, i18n) : undefined;
        const action = userAction
            ? await vscode.window.showWarningMessage(message, showDetails, userAction)
            : await vscode.window.showWarningMessage(message, showDetails);

        if (action === showDetails) {
            await vscode.commands.executeCommand('otak-proxy.diagnoseProxy');
            return;
        }

        if (issue && action === userAction) {
            await this.executeUserAction(issue);
        }
    }

    private shouldNotifyForIssue(issue: ProxyIssue, settings: V3Settings): boolean {
        if (settings.notificationLevel === 'all') {
            return true;
        }

        if (settings.notificationLevel === 'important') {
            return isUserActionIssue(issue);
        }

        return isUserActionIssue(issue);
    }

    private actionLabelForIssue(issue: ProxyIssue, i18n: I18nManager): string | undefined {
        if (issue.userAction === 'openNewTerminal') {
            return i18n.t('action.openNewTerminal');
        }
        if (issue.userAction === 'reloadWindow') {
            return i18n.t('action.reloadWindow');
        }
        return undefined;
    }

    private async executeUserAction(issue: ProxyIssue): Promise<void> {
        if (issue.userAction === 'openNewTerminal') {
            await vscode.commands.executeCommand('workbench.action.terminal.new');
            return;
        }
        if (issue.userAction === 'reloadWindow') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }

    private async notifyLockDivergenceIfNeeded(
        report: ProxyDiagnosticReport | undefined,
        settings: V3Settings,
        options: SafeProxyApplyOptions
    ): Promise<void> {
        if (options.silent || settings.notificationLevel === 'off') {
            return;
        }

        // Losing the lock race is not user-actionable: the winning window
        // converges the machine to the same shared state in almost every case,
        // so a "this window skipped the write" warning is pure noise (#30).
        // Only surface a notification when post-wait diagnostics still see an
        // issue that blocks convergence — that is a real divergence the user
        // may need to look at.
        const issue = getHighestPriorityIssue(
            report?.issues.filter(candidate => candidate.impact === 'blocksConvergence') ?? []
        );
        if (!issue) {
            return;
        }

        if (!(await this.flapTracker.shouldNotify(issue.fingerprint, flapSettings(settings)))) {
            return;
        }

        const i18n = I18nManager.getInstance();
        const showDetails = i18n.t('action.showDetails');
        const action = await vscode.window.showWarningMessage(
            i18n.t('remediation.notification.issueDetected'),
            showDetails
        );
        if (action === showDetails) {
            await vscode.commands.executeCommand('otak-proxy.diagnoseProxy');
        }
    }

    private async ensureCredentialTargetConsent(
        proxyUrl: string,
        options: SafeProxyApplyOptions,
        settings: V3Settings
    ): Promise<boolean> {
        if (!proxyUrl || !hasProxyCredentials(proxyUrl)) {
            return true;
        }

        if (settings.credentialTargetPolicy === 'allowPlaintextTargets') {
            return true;
        }

        if (settings.credentialTargetPolicy === 'blockPlaintextTargets') {
            Logger.warn('Skipped proxy apply because credential-bearing target writes are blocked by policy.');
            return false;
        }

        const publicUrl = removeProxyCredentials(proxyUrl) || proxyUrl;
        const consentKey = publicFingerprint(publicUrl);
        const consent = this.context.globalState.get<Record<string, boolean>>(CREDENTIAL_TARGET_CONSENT_KEY, {});
        if (consent[consentKey]) {
            return true;
        }

        if (options.silent) {
            Logger.warn('Skipped silent proxy apply because credential target consent is required on this machine.');
            return false;
        }

        const i18n = I18nManager.getInstance();
        const allow = i18n.t('action.allowPlaintextWrite');
        const showDetails = i18n.t('action.showDetails');
        const action = await vscode.window.showWarningMessage(
            i18n.t('remediation.notification.credentialConsentRequired'),
            allow,
            showDetails
        );

        if (action === allow) {
            await this.context.globalState.update(CREDENTIAL_TARGET_CONSENT_KEY, {
                ...consent,
                [consentKey]: true
            });
            return true;
        }

        if (action === showDetails) {
            await vscode.commands.executeCommand('otak-proxy.diagnoseProxy');
        }
        return false;
    }

    private applyFailureFingerprint(
        proxyUrl: string,
        enabled: boolean,
        applyResult: ProxyApplyDetailedResult
    ): string {
        // Key the flap bucket on stable identity only (the on/off apply of this
        // URL). The set of currently-failing targets is volatile — an external
        // tool alternating which target it stomps would otherwise land every
        // attempt in a fresh bucket and bypass flap detection entirely (#15).
        // A disable (OFF) apply ignores the URL — it just unsets the proxy, and
        // different callers pass different (or empty) prior URLs — so normalize the
        // URL away when !enabled to keep OFF failures in one bucket.
        const publicUrl = enabled ? (removeProxyCredentials(proxyUrl) || proxyUrl || applyResult.proxyUrl) : '';
        return crypto
            .createHash('sha256')
            .update(`${enabled ? 'on' : 'off'}\n${publicUrl}`)
            .digest('hex');
    }

    private convergenceIssueFingerprint(proxyUrl: string, enabled: boolean, issue: ProxyIssue): string {
        // Stable identity: the on/off apply + the issue (id/targetId) + what we
        // EXPECT. The observed value (actualSanitized) is volatile — a tool that
        // leaves a different residual each time must not reset the flap bucket (#15).
        // OFF ignores the URL, so normalize it away when !enabled (see above).
        const publicUrl = enabled ? (removeProxyCredentials(proxyUrl) || proxyUrl || issue.expectedSanitized || '') : '';
        return crypto
            .createHash('sha256')
            .update([
                enabled ? 'on' : 'off',
                publicUrl,
                issue.id,
                issue.targetId,
                issue.expectedSanitized ?? ''
            ].join('\n'))
            .digest('hex');
    }

    private getWriteTargets(): ApplyLockRequest[] {
        return [
            { targetId: 'git.global.http.proxy', targetHost: 'workspaceHost', scope: 'hostUser' },
            { targetId: 'npm.user.proxy', targetHost: 'workspaceHost', scope: 'hostUser' },
            { targetId: 'terminal.env.proxy', targetHost: 'workspaceHost', scope: 'profile' },
            { targetId: 'vscode.http.proxy', targetHost: 'workspaceHost', scope: 'profile' }
        ];
    }
}
