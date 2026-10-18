import * as assert from 'assert';
import {
    captureLogicalGeneration,
    isStaleGeneration,
    proxyUrlIdentity,
    sameLogicalIdentity
} from '../../core/LogicalGeneration';
import { ProxyMode } from '../../core/types';

suite('LogicalGeneration (#17)', () => {
    test('distinguishes credential rotation and a different user on the same host', () => {
        const host = 'http://proxy.example.com:8080';
        const userA = 'http://alice:old@proxy.example.com:8080';
        const rotated = 'http://alice:new@proxy.example.com:8080';
        const userB = 'http://bob:old@proxy.example.com:8080';

        assert.notStrictEqual(proxyUrlIdentity(host), proxyUrlIdentity(userA));
        assert.notStrictEqual(proxyUrlIdentity(userA), proxyUrlIdentity(rotated));
        assert.notStrictEqual(proxyUrlIdentity(userA), proxyUrlIdentity(userB));
    });

    test('A→B→A is stale because revision advanced even when the URL matches again', () => {
        const firstA = captureLogicalGeneration({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080',
            revision: 1
        });
        const backToA = {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://a.example:8080',
            revision: 3
        };

        assert.strictEqual(isStaleGeneration(firstA, backToA), true);
        assert.strictEqual(
            sameLogicalIdentity(firstA, captureLogicalGeneration(backToA)),
            true,
            'URL-only comparison would treat this as current'
        );
    });

    test('different manual or fallback URL is a new generation at the same revision', () => {
        const started = captureLogicalGeneration({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            revision: 4
        });

        assert.strictEqual(isStaleGeneration(started, {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            manualProxyUrl: 'http://manual.example:3128',
            revision: 4
        }), true);
        assert.strictEqual(isStaleGeneration(started, {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            fallbackProxyUrl: 'http://fallback.example:3128',
            revision: 4
        }), true);
    });

    test('same URL after restart is a new generation once revision is bumped', () => {
        const beforeRestart = captureLogicalGeneration({
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            revision: 7
        });

        assert.strictEqual(isStaleGeneration(beforeRestart, {
            mode: ProxyMode.Auto,
            autoProxyUrl: 'http://proxy.example:8080',
            revision: 8
        }), true);
    });
});
