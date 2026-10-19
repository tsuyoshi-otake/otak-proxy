import * as assert from 'assert';
import * as sinon from 'sinon';
import { ProxyChangeLogger } from '../../monitoring/ProxyChangeLogger';
import { ProxyMonitor } from '../../monitoring/ProxyMonitor';
import {
    DEFAULT_PROXY_MONITOR_CONFIG,
    normalizeProxyMonitorConfig,
    settingSecondsToMs
} from '../../monitoring/ProxyMonitorConfig';
import type { ProxyMonitorConfig } from '../../monitoring/ProxyMonitorTypes';
import { InputSanitizer } from '../../validation/InputSanitizer';

// A value of the wrong type reaches the monitor when a workspace file supplies
// a machine-overridable setting; the cast is the point of these tests.
function withValue<K extends keyof ProxyMonitorConfig>(key: K, value: unknown): ProxyMonitorConfig {
    return { ...DEFAULT_PROXY_MONITOR_CONFIG, [key]: value } as ProxyMonitorConfig;
}

suite('normalizeProxyMonitorConfig (#108)', () => {
    const defaults = DEFAULT_PROXY_MONITOR_CONFIG;

    const table: Array<{ key: keyof ProxyMonitorConfig; input: unknown; expected: number; label: string }> = [
        { key: 'pollingInterval', input: NaN, expected: defaults.pollingInterval, label: 'NaN' },
        { key: 'pollingInterval', input: Infinity, expected: defaults.pollingInterval, label: 'Infinity' },
        { key: 'pollingInterval', input: 'abc', expected: defaults.pollingInterval, label: 'text' },
        { key: 'pollingInterval', input: '60000', expected: defaults.pollingInterval, label: 'numeric text' },
        { key: 'pollingInterval', input: -1, expected: 10_000, label: 'negative' },
        { key: 'pollingInterval', input: 5_000, expected: 10_000, label: 'below the minimum' },
        { key: 'pollingInterval', input: 10 ** 12, expected: 300_000, label: 'huge' },
        { key: 'pollingInterval', input: 45_000, expected: 45_000, label: 'in range' },
        { key: 'connectionTestInterval', input: NaN, expected: defaults.connectionTestInterval, label: 'NaN' },
        { key: 'connectionTestInterval', input: -Infinity, expected: defaults.connectionTestInterval, label: '-Infinity' },
        { key: 'connectionTestInterval', input: '90000', expected: defaults.connectionTestInterval, label: 'numeric text' },
        { key: 'connectionTestInterval', input: 1, expected: 30_000, label: 'below the minimum' },
        { key: 'connectionTestInterval', input: 10 ** 12, expected: 600_000, label: 'huge' },
        { key: 'connectionTestInterval', input: 90_000, expected: 90_000, label: 'in range' },
        { key: 'maxRetries', input: NaN, expected: defaults.maxRetries, label: 'NaN' },
        { key: 'maxRetries', input: Infinity, expected: defaults.maxRetries, label: 'Infinity' },
        { key: 'maxRetries', input: 'abc', expected: defaults.maxRetries, label: 'text' },
        { key: 'maxRetries', input: '5', expected: defaults.maxRetries, label: 'numeric text' },
        { key: 'maxRetries', input: -1, expected: 0, label: 'negative' },
        { key: 'maxRetries', input: 2.7, expected: 2, label: 'fraction (floored)' },
        { key: 'maxRetries', input: 10 ** 9, expected: 10, label: 'huge' },
        { key: 'debounceDelay', input: NaN, expected: defaults.debounceDelay, label: 'NaN' },
        { key: 'debounceDelay', input: 0, expected: defaults.debounceDelay, label: 'zero' },
        { key: 'debounceDelay', input: -5, expected: defaults.debounceDelay, label: 'negative' },
        { key: 'debounceDelay', input: 250, expected: 250, label: 'in range' },
        { key: 'retryBackoffBase', input: NaN, expected: defaults.retryBackoffBase, label: 'NaN' },
        { key: 'retryBackoffBase', input: Infinity, expected: defaults.retryBackoffBase, label: 'Infinity' },
        { key: 'retryBackoffBase', input: 0, expected: defaults.retryBackoffBase, label: 'zero' },
        { key: 'retryBackoffBase', input: 2, expected: 2, label: 'in range' }
    ];

    for (const row of table) {
        test(`${row.key}: ${row.label} becomes ${row.expected}`, () => {
            const normalized = normalizeProxyMonitorConfig(withValue(row.key, row.input));
            assert.strictEqual(normalized[row.key], row.expected);
        });
    }

    test('settingSecondsToMs converts numbers and turns anything else into NaN', () => {
        assert.strictEqual(settingSecondsToMs(60), 60_000);
        assert.ok(Number.isNaN(settingSecondsToMs('60')));
        assert.ok(Number.isNaN(settingSecondsToMs(undefined)));
        assert.ok(Number.isNaN(settingSecondsToMs(null)));
    });
});

suite('ProxyMonitor with settings that are not numbers (#108)', () => {
    let clock: sinon.SinonFakeTimers;
    let monitor: ProxyMonitor | undefined;
    let checks: number;
    let failing: boolean;
    let logger: ProxyChangeLogger;

    const detector = {
        detectSystemProxy: async (): Promise<string | null> => {
            checks++;
            if (failing) {
                throw new Error('detection failed');
            }
            return null;
        }
    };

    setup(() => {
        clock = sinon.useFakeTimers();
        checks = 0;
        failing = false;
        logger = new ProxyChangeLogger(new InputSanitizer());
    });

    teardown(() => {
        monitor?.stop();
        monitor = undefined;
        clock.restore();
    });

    test('a NaN polling interval polls at the default 30 s instead of never or in a tight loop', async () => {
        const setIntervalSpy = sinon.spy(global, 'setInterval');
        try {
            monitor = new ProxyMonitor(detector, logger, {
                pollingInterval: NaN,
                debounceDelay: 1,
                enableConnectionTest: false
            });
            monitor.start();

            assert.strictEqual(setIntervalSpy.lastCall.args[1], 30_000, 'the interval handed to the timer');
            await clock.tickAsync(29_000);
            const before = checks;
            await clock.tickAsync(2_000);
            assert.strictEqual(checks - before, 1, 'exactly one polling check when the 30 s mark passes');
        } finally {
            setIntervalSpy.restore();
        }
    });

    test('a NaN maxRetries falls back to 3 retries, after which allRetriesFailed fires (it used to never fire)', async () => {
        monitor = new ProxyMonitor(detector, logger, {
            pollingInterval: 60_000,
            debounceDelay: 1,
            maxRetries: NaN,
            retryBackoffBase: 0.001,
            enableConnectionTest: false
        });
        const exhausted: unknown[] = [];
        monitor.on('allRetriesFailed', data => exhausted.push(data));
        failing = true;
        monitor.start();

        const executeCheck = (monitor as unknown as { executeCheck(trigger: string): Promise<unknown> }).executeCheck.bind(monitor);
        // A failed check schedules its retries on the fake clock; advance past all of them.
        const check = executeCheck('network');
        await clock.tickAsync(60_000);
        await check;

        assert.strictEqual(exhausted.length, 1, 'retries are exhausted once instead of never');
        assert.strictEqual(checks, 4, 'the first attempt plus the default of 3 retries');
    });
});
