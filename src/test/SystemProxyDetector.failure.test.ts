import * as assert from 'assert';
import * as sinon from 'sinon';
import { SystemProxyDetector } from '../config/SystemProxyDetector';

const PROXY_ENVIRONMENT = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

suite('SystemProxyDetector failed platform query (#108)', () => {
    let sandbox: sinon.SinonSandbox;
    let savedEnvironment: Record<string, string | undefined>;

    setup(() => {
        sandbox = sinon.createSandbox();
        savedEnvironment = {};
        for (const name of PROXY_ENVIRONMENT) {
            savedEnvironment[name] = process.env[name];
            delete process.env[name];
        }
    });

    teardown(() => {
        sandbox.restore();
        for (const name of PROXY_ENVIRONMENT) {
            if (savedEnvironment[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = savedEnvironment[name];
            }
        }
    });

    function detectorWithFailingExec(priority: string[]): SystemProxyDetector {
        const detector = new SystemProxyDetector(priority);
        sandbox.stub(detector as unknown as { exec(): Promise<never> }, 'exec')
            .rejects(Object.assign(new Error('Command failed: platform query'), { stderr: 'access denied' }));
        return detector;
    }

    test('the real detector with a failing exec reports unknown, not "no proxy"', async () => {
        const detector = detectorWithFailingExec(['platform']);

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.strictEqual(result.kind, 'unknown');
    });

    test('detectSystemProxy() keeps returning null on a failed query', async () => {
        const detector = detectorWithFailingExec(['platform']);

        assert.strictEqual(await detector.detectSystemProxy(), null);
    });

    test('unknown from the platform does not hide a later source that has a proxy', async () => {
        process.env.HTTP_PROXY = 'http://env-proxy.example.com:8080';
        const detector = detectorWithFailingExec(['platform', 'environment']);

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, 'http://env-proxy.example.com:8080');
        assert.strictEqual(result.source, 'environment');
    });

    test('unknown from the platform survives later sources that find nothing', async () => {
        const detector = detectorWithFailingExec(['platform', 'environment']);

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.kind, 'unknown');
    });

    test('a source that throws is unknown, and later sources are still tried', async () => {
        process.env.HTTPS_PROXY = 'http://env-proxy.example.com:8443';
        const detector = new SystemProxyDetector(['platform', 'environment']);
        const known = detector as unknown as { detectKnownSource(source: string): Promise<unknown> };
        const original = known.detectKnownSource.bind(detector);
        sandbox.stub(known, 'detectKnownSource').callsFake(async (source: string) => {
            if (source === 'platform') {
                throw new Error('platform source crashed');
            }
            return original(source);
        });

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.source, 'environment');
        assert.strictEqual(result.proxyUrl, 'http://env-proxy.example.com:8443');
    });

    test('a lone throwing source is unknown', async () => {
        const detector = new SystemProxyDetector(['platform']);
        sandbox.stub(detector as unknown as { detectKnownSource(): Promise<never> }, 'detectKnownSource')
            .rejects(new Error('platform source crashed'));

        assert.strictEqual((await detector.detectSystemProxyWithSource()).kind, 'unknown');
    });

    test('an unrecognized source name is still "no proxy", not a failure', async () => {
        const detector = new SystemProxyDetector(['no-such-source']);

        const result = await detector.detectSystemProxyWithSource();

        assert.strictEqual(result.proxyUrl, null);
        assert.notStrictEqual(result.kind, 'unknown');
    });
});
