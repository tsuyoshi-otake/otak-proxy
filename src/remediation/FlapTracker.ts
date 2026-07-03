import type * as vscode from 'vscode';
import { ProxyIssueCategory } from '../core/v3Types';

export const FLAP_TRACKER_KEY = 'otakProxy.v3.flapTracker';

export interface FlapTrackerSettings {
    windowMs: number;
    maxAttempts: number;
    cooldownMs: number;
    notificationCooldownMs: number;
}

export interface FlapAttemptDecision {
    allowed: boolean;
    attemptsInWindow: number;
    cooldownUntil?: number;
}

export interface FlapConvergenceResult {
    escalated: boolean;
    attemptsInWindow: number;
    cooldownUntil?: number;
}

interface FlapRecord {
    attempts: number[];
    cooldownUntil?: number;
    lastNotificationAt?: number;
    lastCategory?: ProxyIssueCategory;
}

interface FlapState {
    records: Record<string, FlapRecord>;
}

function pruneAttempts(attempts: readonly number[], now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    return attempts.filter(attempt => attempt >= cutoff);
}

export class FlapTracker {
    constructor(
        private readonly globalState: vscode.Memento,
        private readonly now: () => number = () => Date.now()
    ) {}

    async recordAttempt(fingerprint: string, settings: FlapTrackerSettings): Promise<FlapAttemptDecision> {
        const state = this.getState();
        const now = this.now();
        const record = this.getRecord(state, fingerprint);
        record.attempts = pruneAttempts(record.attempts, now, settings.windowMs);

        if (record.cooldownUntil && record.cooldownUntil > now) {
            await this.saveState(state);
            return {
                allowed: false,
                attemptsInWindow: record.attempts.length,
                cooldownUntil: record.cooldownUntil
            };
        }

        if (record.attempts.length >= settings.maxAttempts) {
            record.cooldownUntil = now + settings.cooldownMs;
            await this.saveState(state);
            return {
                allowed: false,
                attemptsInWindow: record.attempts.length,
                cooldownUntil: record.cooldownUntil
            };
        }

        record.attempts.push(now);
        record.cooldownUntil = undefined;
        await this.saveState(state);
        return {
            allowed: true,
            attemptsInWindow: record.attempts.length
        };
    }

    async recordNonConvergence(
        fingerprint: string,
        category: ProxyIssueCategory,
        settings: FlapTrackerSettings
    ): Promise<FlapConvergenceResult> {
        const state = this.getState();
        const now = this.now();
        const record = this.getRecord(state, fingerprint);
        record.attempts = pruneAttempts(record.attempts, now, settings.windowMs);
        record.lastCategory = category;

        const escalated = record.attempts.length >= settings.maxAttempts;
        if (escalated) {
            record.cooldownUntil = now + settings.cooldownMs;
        }

        await this.saveState(state);
        return {
            escalated,
            attemptsInWindow: record.attempts.length,
            cooldownUntil: record.cooldownUntil
        };
    }

    async reset(fingerprint: string): Promise<void> {
        const state = this.getState();
        delete state.records[fingerprint];
        await this.saveState(state);
    }

    async shouldNotify(fingerprint: string, settings: FlapTrackerSettings): Promise<boolean> {
        const state = this.getState();
        const record = this.getRecord(state, fingerprint);
        const now = this.now();
        if (record.lastNotificationAt && now - record.lastNotificationAt < settings.notificationCooldownMs) {
            await this.saveState(state);
            return false;
        }

        record.lastNotificationAt = now;
        await this.saveState(state);
        return true;
    }

    getRecordForTest(fingerprint: string): FlapRecord | undefined {
        return this.getState().records[fingerprint];
    }

    private getState(): FlapState {
        return this.globalState.get<FlapState>(FLAP_TRACKER_KEY, { records: {} });
    }

    private async saveState(state: FlapState): Promise<void> {
        await this.globalState.update(FLAP_TRACKER_KEY, state);
    }

    private getRecord(state: FlapState, fingerprint: string): FlapRecord {
        state.records[fingerprint] ??= { attempts: [] };
        return state.records[fingerprint];
    }
}
