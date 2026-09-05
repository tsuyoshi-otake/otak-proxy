/**
 * Property-based tests for ProxyConnectRequest default-port restoration.
 * Issue #54: empty WHATWG ports must map to scheme defaults; explicit ports win.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { getPropertyTestRuns, getPropertyTestTimeout } from '../helpers';
import { buildConnectRequestOptions } from '../../utils/ProxyConnectRequest';

function schemeDefaultPort(protocol: string): number {
    return protocol === 'https:' ? 443 : 80;
}

suite('ProxyConnectRequest port properties', function() {
    const numRuns = getPropertyTestRuns();
    this.timeout(getPropertyTestTimeout(30000));

    test('explicit proxy and target ports are preserved', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 65535 }).filter(port => port !== 80 && port !== 443),
                fc.integer({ min: 1, max: 65535 }).filter(port => port !== 80 && port !== 443),
                fc.constantFrom('http:', 'https:'),
                fc.constantFrom('http:', 'https:'),
                (proxyPort, targetPort, proxyProtocol, targetProtocol) => {
                    const proxy = new URL(`${proxyProtocol}//proxy.example:${proxyPort}`);
                    const target = new URL(`${targetProtocol}//example.com:${targetPort}`);
                    const options = buildConnectRequestOptions(proxy, target, 1000);

                    assert.strictEqual(options.port, proxyPort);
                    assert.strictEqual(options.path, `example.com:${targetPort}`);
                }
            ),
            { numRuns }
        );
    });

    test('omitted or scheme-default ports restore http 80 and https 443', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('http:', 'https:'),
                fc.constantFrom('http:', 'https:'),
                fc.constantFrom('omit', 'scheme-default'),
                fc.constantFrom('omit', 'scheme-default'),
                (proxyProtocol, targetProtocol, proxyMode, targetMode) => {
                    const proxyDefault = schemeDefaultPort(proxyProtocol);
                    const targetDefault = schemeDefaultPort(targetProtocol);
                    const proxyHref = proxyMode === 'omit'
                        ? `${proxyProtocol}//proxy.example`
                        : `${proxyProtocol}//proxy.example:${proxyDefault}`;
                    const targetHref = targetMode === 'omit'
                        ? `${targetProtocol}//example.com`
                        : `${targetProtocol}//example.com:${targetDefault}`;

                    const proxy = new URL(proxyHref);
                    const target = new URL(targetHref);
                    assert.strictEqual(proxy.port, '');
                    assert.strictEqual(target.port, '');

                    const options = buildConnectRequestOptions(proxy, target, 1000);
                    assert.strictEqual(options.port, proxyDefault);
                    assert.strictEqual(options.path, `example.com:${targetDefault}`);
                }
            ),
            { numRuns }
        );
    });
});
