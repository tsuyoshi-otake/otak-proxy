import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ProxyDiagnosticReport, ProxyRuntimeDiagnostics } from '../diagnostics/ProxyRuntimeDiagnostics';
import { I18nManager } from '../i18n/I18nManager';
import { ProxyApplyDetailedResult, ProxyApplyOptions } from '../core/ProxyApplierTypes';
import { publicFingerprint, TargetOwnershipStore } from '../core/TargetOwnershipStore';
import { ProxyState } from '../core/types';
import { getHighestPriorityIssue, ProxyIssue } from '../core/v3Types';
import { readV3Settings, V3Settings } from '../core/V3Settings';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';
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
const CREDENTIAL_TARGET_CONSENT_KEY = 'otakProxy.v3.credentialTargetConsent';
const RETRYABLE_CONVERGENCE_ISSUE_IDS = new Set([
    'git.managedProxyResidual',
    'npm.managedProxyResidual',
    'vscode.managedProxyResidual',
    'git.managedProxyMismatch',
    'npm.managedProxyMismatch',
    'vscode.managedProxyMismatch'
]);

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
        issue.category === 'needsNewTerminal' ||
        issue.category === 'needsWindowsPermission' ||
        issue.category === 'needsCredentialConsent';
}

export class ProxyRemediationService {
    private readonly lockService: ApplyLockService;
    private readonly flapTracker: FlapTracker;
    private readonly diagnostics: ProxyRuntimeDiagnostics;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly ownershipStore: TargetOwnershipStore;
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
        this.ownershipStore = new TargetOwnershipStore(
            context.globalState,
            new ProxyCredentialStore(context.secrets)
        );
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

        const lockResult = await this.lockService.withLocks(targets, DEFAULT_LOCK_TTL_MS, task);
        if (lockResult.acquired) {
            return lockResult.value;
        }

        const diagnosticReport = await this.runDiagnosticsIfEnabled(settings);
        Logger.warn('Skipped proxy apply because another otak-proxy window owns the apply lock.');
        this.notifyAfterApply(() => this.notifyLockSkipped(settings, options));
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

        let diagnosticReport = await this.runDiagnosticsIfEnabled(settings, true);
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
            await this.markOwnershipFromSuccessfulApply(proxyUrl, applyResult.enabled);
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
            options.trigger !== 'sync' &&
            applyResult.errors.length > 0;
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
            options.trigger !== 'sync' &&
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
        const shouldWarnForApply = !applyResult.success || retrySuppressed;
        const shouldWarnForIssue = Boolean(issue && this.shouldNotifyForIssue(issue, settings));

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
            return issue.impact === 'blocksConvergence' || issue.impact === 'requiresUserDecision';
        }

        return issue.impact === 'blocksConvergence' || isUserActionIssue(issue);
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

    private async notifyLockSkipped(settings: V3Settings, options: SafeProxyApplyOptions): Promise<void> {
        if (options.silent || settings.notificationLevel === 'off') {
            return;
        }

        const i18n = I18nManager.getInstance();
        const fingerprint = 'apply-lock-skipped';
        if (!(await this.flapTracker.shouldNotify(fingerprint, flapSettings(settings)))) {
            return;
        }

        const showDetails = i18n.t('action.showDetails');
        const action = await vscode.window.showWarningMessage(
            i18n.t('remediation.notification.lockSkipped'),
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

    private async markOwnershipFromSuccessfulApply(proxyUrl: string, enabled: boolean): Promise<void> {
        const targets = this.getWriteTargets();
        const now = Date.now();

        if (!enabled) {
            for (const target of targets) {
                await this.ownershipStore.update({
                    targetId: target.targetId,
                    targetHost: target.targetHost,
                    owner: 'otakProxy',
                    publicFingerprint: publicFingerprint(''),
                    lastSuccessfulApplyAt: now,
                    lastObservedHash: publicFingerprint(''),
                    lastObservedAt: now
                });
            }
            return;
        }

        const publicUrl = removeProxyCredentials(proxyUrl) || proxyUrl;
        await this.ownershipStore.bootstrapFromSnapshot(
            publicUrl,
            targets.map(target => ({
                targetId: target.targetId,
                targetHost: target.targetHost,
                value: publicUrl
            })),
            proxyUrl
        );
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
