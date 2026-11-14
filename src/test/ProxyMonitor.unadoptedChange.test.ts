/**
 * #136 item 1, the monitor's side of the contract: a listener that did not
 * adopt a proxyChanged event says so, and the next check reports the detection
 * again. The handler's side and the wiring are tested in
 * core/UnadoptedProxyChange.flow.test.ts.
 */
import * as assert from 'assert';
import { ProxyChangeLogger } from '../monitoring/ProxyChangeLogger';
import { ProxyDetectionResult, ProxyMonitor } from '../monitoring/ProxyMonitor';
import type { ProxyCheckTrigger } from '../monitoring/ProxyMonitorTypes';
import { InputSanitizer } from '../validation/InputSanitizer';

const X = 'http://proxy-x.example.com:8080';
const Y = 'http://proxy-y.example.com:8080';
const Z = 'http://proxy-z.example.com:8080';

suite('ProxyMonitor re-reports a change the listener did not adopt (#136)', () => {
    let monitor: ProxyMonitor;
    let detected: string | null;
    let reports: ProxyDetectionResult[];

    setup(() => {
        detected = X;
        reports = [];
        monitor = new ProxyMonitor(
            { detectSystemProxy: async () => detected },
            new ProxyChangeLogger(new InputSanitizer()),
            { pollingInterval: 60_000, debounceDelay: 1000, maxRetries: 0, enableConnectionTest: false }
        );
        monitor.on('proxyChanged', (result: ProxyDetectionResult) => reports.push(result));
        monitor.start();
    });

    teardown(() => {
        monitor.stop();
    });

    async function check(proxyUrl: string | null): Promise<void> {
        detected = proxyUrl;
        await (monitor as unknown as { executeCheck(trigger: ProxyCheckTrigger): Promise<unknown> }).executeCheck('polling');
    }

    const reportedUrls = () => reports.map(report => report.proxyUrl);

    test('control: a reported change is not reported again at the next check', async () => {
        await check(X);
        await check(Y);
        await check(Y);

        assert.deepStrictEqual(reportedUrls(), [X, Y]);
    });

    test('the latest report that was not adopted is reported again, once', async () => {
        await check(X);
        await check(Y);

        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Y);
        await check(Y);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Y]);
    });

    test('a not-adopted answer does not make a different detection look unchanged', async () => {
        await check(X);
        await check(Y);

        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Z);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Z]);
    });

    test('an answer for a report a newer one replaced is ignored', async () => {
        await check(X);
        await check(Y);
        await check(Z);

        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Z);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Z], 'Z is the latest report; the answer for Y changes nothing');
    });

    test('an answer for a report that was already answered is ignored', async () => {
        await check(X);
        await check(Y);

        monitor.proxyChangeNotAdopted(reports[1]);
        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Y);
        await check(Y);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Y]);
    });

    test('an answer that arrives after stop() is ignored: the start path detects afresh', async () => {
        await check(X);
        await check(Y);

        monitor.stop();
        monitor.start();
        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Y);

        assert.deepStrictEqual(reportedUrls(), [X, Y]);
    });

    test('a failed check keeps the pending re-report for the next successful one', async () => {
        await check(X);
        await check(Y);
        monitor.proxyChangeNotAdopted(reports[1]);

        (monitor as unknown as { detector: unknown }).detector = {
            detectSystemProxy: async () => { throw new Error('platform query failed'); }
        };
        await check(Y);
        (monitor as unknown as { detector: unknown }).detector = { detectSystemProxy: async () => detected };
        await check(Y);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Y]);
    });

    test('repeats are bounded: a change answered not-adopted every time is reported 4 times in all', async () => {
        await check(X);

        for (let attempt = 0; attempt < 8; attempt++) {
            await check(Y);
            const latest = reports[reports.length - 1];
            if (latest.proxyUrl === Y) {
                monitor.proxyChangeNotAdopted(latest);
            }
        }

        assert.deepStrictEqual(
            reportedUrls(),
            [X, Y, Y, Y, Y],
            'the first report and three repeats; then the detection stays reported'
        );
    });

    test('an unchanged check while a report is still unanswered does not reset the streak', async () => {
        await check(X);

        // The listener answers asynchronously: an unchanged poll that runs
        // before the answer arrives must not count as the streak ending —
        // otherwise every rejected report restarts the count at zero and
        // MAX_REREPORTS is never reached.
        const emittedY = () => reportedUrls().filter(url => url === Y).length;
        for (let attempt = 0; attempt < 10 && emittedY() < 6; attempt++) {
            const countBefore = reports.length;
            await check(Y);
            if (reports.length === countBefore) {
                continue;
            }
            const latest = reports[reports.length - 1];
            // The report is still unanswered when the next check sees the
            // same detection; only then does the rejection land.
            await check(Y);
            monitor.proxyChangeNotAdopted(latest);
        }

        assert.strictEqual(emittedY(), 4, 'the first report plus the three bounded repeats');
    });

    test('a report the listener settled breaks the rejection streak', async () => {
        await check(X);
        await check(Y);
        monitor.proxyChangeNotAdopted(reports[1]);
        await check(Y);

        // The repeat is settled this time: a streak of one ends here.
        monitor.proxyChangeSettled(reports[2]);

        // Two rejections on the next change produce two re-reports — the
        // earlier rejection may not carry over through the settled report.
        await check(Z);
        monitor.proxyChangeNotAdopted(reports[3]);
        await check(Z);
        monitor.proxyChangeNotAdopted(reports[4]);
        await check(Z);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Y, Z, Z, Z]);
    });

    test('a report left unanswered at stop() does not count as outstanding in the next lifecycle', async () => {
        await check(X);
        await check(Y); // Y reported; the listener never answers before stop()

        monitor.stop();

        assert.strictEqual(
            (monitor as unknown as { lastReport?: unknown }).lastReport,
            undefined,
            'a stopped lifecycle has no outstanding report: a late answer for it is ignored anyway'
        );

        monitor.start();

        // The late answer for the stale report is ignored, and the new
        // lifecycle behaves normally: Z reports, settles, stays quiet.
        monitor.proxyChangeNotAdopted(reports[reports.length - 1]);
        await check(Z);
        monitor.proxyChangeSettled(reports[reports.length - 1]);
        await check(Z);
        assert.deepStrictEqual(reportedUrls(), [X, Y, Z]);
    });

    test('a settled answer for a report a newer one replaced is ignored', async () => {
        await check(X);
        await check(Y);
        await check(Z);

        monitor.proxyChangeSettled(reports[1]);
        await check(Z);

        assert.deepStrictEqual(reportedUrls(), [X, Y, Z], 'the stale answer changed nothing');
    });

    test('a quiet check ends the streak: the next change is repeated again', async () => {
        await check(X);
        for (let attempt = 0; attempt < 6; attempt++) {
            await check(Y);
            const latest = reports[reports.length - 1];
            if (latest.proxyUrl === Y) {
                monitor.proxyChangeNotAdopted(latest);
            }
        }
        await check(Y);
        const before = reports.length;

        await check(Z);
        monitor.proxyChangeNotAdopted(reports[reports.length - 1]);
        await check(Z);

        assert.strictEqual(reports.length, before + 2, 'Z is reported, answered, and reported again');
    });
});
