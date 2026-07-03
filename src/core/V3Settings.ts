import * as vscode from 'vscode';

export type V3NotificationLevel = 'off' | 'important' | 'warnings' | 'all';
export type V3CredentialTargetPolicy = 'ask' | 'allowPlaintextTargets' | 'blockPlaintextTargets';

export interface V3Settings {
    diagnosticsEnabled: boolean;
    automaticRemediationEnabled: boolean;
    hostUserLockEnabled: boolean;
    automaticRetryEnabled: boolean;
    delayedRetryMs: number;
    flapWindowMs: number;
    flapMaxAttempts: number;
    flapCooldownMs: number;
    notificationCooldownMs: number;
    slowDiagnosticsTtlMs: number;
    terminalOffMaskingEnabled: boolean;
    notificationLevel: V3NotificationLevel;
    windowsActionsEnabled: boolean;
    credentialTargetPolicy: V3CredentialTargetPolicy;
    legacyEnvFirstAutoDetection: boolean;
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.max(min, Math.min(max, value));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? value as T
        : fallback;
}

export function readV3Settings(config = vscode.workspace.getConfiguration('otakProxy')): V3Settings {
    return {
        diagnosticsEnabled: config.get<boolean>('diagnosticsEnabled', true),
        automaticRemediationEnabled: config.get<boolean>('automaticRemediationEnabled', true),
        hostUserLockEnabled: config.get<boolean>('hostUserLockEnabled', true),
        automaticRetryEnabled: config.get<boolean>('automaticRetryEnabled', true),
        delayedRetryMs: clampNumber(config.get<number>('remediationDelayedRetryMs', 2000), 250, 30000),
        flapWindowMs: clampNumber(config.get<number>('remediationFlapWindowMs', 600000), 60000, 3600000),
        flapMaxAttempts: clampNumber(config.get<number>('remediationFlapMaxAttempts', 2), 1, 10),
        flapCooldownMs: clampNumber(config.get<number>('remediationFlapCooldownMs', 600000), 60000, 7200000),
        notificationCooldownMs: clampNumber(config.get<number>('notificationCooldownMs', 600000), 10000, 7200000),
        slowDiagnosticsTtlMs: clampNumber(config.get<number>('slowDiagnosticsTtlMs', 300000), 30000, 3600000),
        terminalOffMaskingEnabled: config.get<boolean>('terminalOffMaskingEnabled', true),
        notificationLevel: enumValue(
            config.get<string>('notificationLevel', 'warnings'),
            ['off', 'important', 'warnings', 'all'] as const,
            'warnings'
        ),
        windowsActionsEnabled: config.get<boolean>('windowsActionsEnabled', false),
        credentialTargetPolicy: enumValue(
            config.get<string>('credentialTargetPolicy', 'ask'),
            ['ask', 'allowPlaintextTargets', 'blockPlaintextTargets'] as const,
            'ask'
        ),
        legacyEnvFirstAutoDetection: config.get<boolean>('legacyEnvFirstAutoDetection', true)
    };
}
