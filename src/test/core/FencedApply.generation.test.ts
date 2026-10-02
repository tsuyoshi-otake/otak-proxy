import * as assert from 'assert';
import { createFencedApply } from '../../core/GenerationFence';
import { captureLogicalGeneration } from '../../core/LogicalGeneration';
import { ProxyApplyDetailedResult } from '../../core/ProxyApplierTypes';
import { saveProxyConfigResults } from '../../core/ProxyConfigStateTracker';
import { ProxyMode, ProxyState, StateCommitResult, stateRevision } from '../../core/types';
import { ErrorAggregator } from '../../errors/ErrorAggregator';

/**
 * #78: a remediation retry of the same desired state must reach the real
 * applier. Each real apply commits its own results (revision +1); that
 * self-commit must not make the retry look like a superseded generation,
 * while any other writer still must.
 */
suite('Fenced apply across remediation retries (#78)', () => {
    interface Harness {
        state: ProxyState;
        realApplies: number;
        manager: {
            getState: () => Promise<ProxyState>;
            saveState: (next: ProxyState) => Promise<void>;
            commitState: (expected: number, next: ProxyState) => Promise<StateCommitResult>;
        };
        /** Behaves like ProxyApplier: captures its own generation, writes, commits results. */
        realApply: (proxyUrl: string, enabled: boolean) => Promise<ProxyApplyDetailedResult>;
        duringApply?: () => void;
    }

    function createHarness(initial: ProxyState): Harness {
        const harness = { state: { revision: 1, ...initial }, realApplies: 0 } as Harness;
        harness.manager = {
            getState: async () => ({ ...harness.state }),
            saveState: async (next: ProxyState) => {
                harness.state = { ...next, revision: stateRevision(harness.state) + 1 };
            },
            commitState: async (expected: number, next: ProxyState): Promise<StateCommitResult> => {
                if (stateRevision(harness.state) !== expected) {
                    return { kind: 'superseded', current: { ...harness.state } };
                }
                harness.state = { ...next, revision: expected + 1 };
                return { kind: 'committed', revision: expected + 1, state: { ...harness.state } };
            }
        };
        harness.realApply = async (proxyUrl: string, enabled: boolean) => {
            const generation = captureLogicalGeneration(harness.state);
            harness.realApplies += 1;
            harness.duringApply?.();
            const results = {
                gitSuccess: true,
                vscodeSuccess: true,
                npmSuccess: true,
                terminalEnvSuccess: true,
                gitOutcome: enabled ? 'configured' as const : 'cleared' as const,
                vscodeOutcome: enabled ? 'configured' as const : 'cleared' as const,
                npmOutcome: enabled ? 'configured' as const : 'cleared' as const,
                terminalEnvOutcome: enabled ? 'configured' as const : 'cleared' as const
            };
            const committedRevision = await saveProxyConfigResults(
                harness.manager as never, enabled, results, new ErrorAggregator(), generation
            );
            return { success: true, enabled, proxyUrl, results, errors: [], committedRevision };
        };
        return harness;
    }

    function fenced(harness: Harness) {
        return createFencedApply(
            harness.manager,
            captureLogicalGeneration(harness.state),
            'manual',
            harness.realApply
        );
    }

    test('a retry after our own result commit reaches the real applier', async () => {
        const harness = createHarness({ mode: ProxyMode.Off });
        const apply = fenced(harness);

        const first = await apply('', false);
        const retry = await apply('', false, { silent: true });

        assert.strictEqual(harness.realApplies, 2, 'the retry must run, not be discarded as stale');
        assert.notStrictEqual(first.superseded, true);
        assert.notStrictEqual(retry.superseded, true);
        assert.strictEqual(stateRevision(harness.state), 3);
    });

    test('a desired-state change by another writer supersedes the retry', async () => {
        const harness = createHarness({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });
        const apply = fenced(harness);

        await apply('http://a.example:8080', true);
        harness.state = { ...harness.state, mode: ProxyMode.Off, revision: stateRevision(harness.state) + 1 };
        const retry = await apply('http://a.example:8080', true, { silent: true });

        assert.strictEqual(harness.realApplies, 1);
        assert.strictEqual(retry.superseded, true);
        assert.strictEqual(harness.state.mode, ProxyMode.Off);
    });

    test('an identity-preserving commit by another writer during the apply still supersedes the retry', async () => {
        // Auto turning OFF keeps mode and URLs, so "revision +1 with the same
        // identity" cannot tell it apart from our own commit. Our commit is
        // discarded as stale here; re-enabling the proxy would be wrong.
        const harness = createHarness({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });
        const apply = fenced(harness);
        harness.duringApply = () => {
            harness.duringApply = undefined;
            harness.state = { ...harness.state, autoModeOff: true, revision: stateRevision(harness.state) + 1 };
        };

        const first = await apply('http://a.example:8080', true);
        const retry = await apply('http://a.example:8080', true, { silent: true });

        assert.strictEqual(first.committedRevision, undefined, 'our own result commit was discarded');
        assert.strictEqual(harness.realApplies, 1, 'only a commit the apply reports may move the fence');
        assert.strictEqual(retry.superseded, true);
        assert.strictEqual(harness.state.autoModeOff, true);
    });

    test('a request already superseded before the first attempt writes nothing', async () => {
        const harness = createHarness({ mode: ProxyMode.Auto, autoProxyUrl: 'http://a.example:8080' });
        const apply = fenced(harness);
        harness.state = { ...harness.state, autoProxyUrl: 'http://b.example:8080', revision: 2 };

        const result = await apply('http://a.example:8080', true);

        assert.strictEqual(harness.realApplies, 0);
        assert.strictEqual(result.superseded, true);
        assert.strictEqual(harness.state.autoProxyUrl, 'http://b.example:8080');
    });
});
