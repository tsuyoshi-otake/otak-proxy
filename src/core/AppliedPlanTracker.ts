import { AppliedPlan } from './ProxyApplyPlan';

export type { AppliedPlan } from './ProxyApplyPlan';

/**
 * A positive record of the last plan this window actually applied.
 *
 * The sync receiver compares a remote state against this record to skip an
 * apply that would rewrite what this window already wrote. It is created at
 * the composition root and passed to `runProxyApplyAttempt` and the receiver
 * explicitly — no module-level singleton, so tests build their own.
 *
 * The record may carry hydrated credentials, so it is in memory only: never
 * logged, persisted or published.
 *
 * Attempts can overlap (the apply lock is cross-process, so a second attempt
 * gets `lockSkipped` — or runs unlocked — while the first still runs), and
 * the last to finish is not necessarily the last writer. An attempt that
 * overlapped another therefore leaves no record.
 */
export class AppliedPlanTracker {
    private inFlight = 0;
    private overlapped = false;
    private last: AppliedPlan | undefined;

    /** An attempt is starting: it cannot prove a prior write anymore. */
    noteAttemptStarted(): void {
        if (this.inFlight > 0) {
            this.overlapped = true;
        }
        this.inFlight++;
        this.last = undefined;
    }

    /**
     * An attempt finished. `applied` is recorded only when the attempt wrote
     * its plan and overlapped no other attempt since the in-flight count was
     * last zero; every other outcome clears the record.
     */
    noteAttemptFinished(applied?: AppliedPlan): void {
        if (this.inFlight > 0) {
            this.inFlight--;
        }
        if (!this.overlapped) {
            this.last = applied;
        }
        if (this.inFlight === 0) {
            this.overlapped = false;
        }
    }

    isApplyInFlight(): boolean {
        return this.inFlight > 0;
    }

    lastAppliedPlan(): AppliedPlan | undefined {
        return this.last;
    }
}
