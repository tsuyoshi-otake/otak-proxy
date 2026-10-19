/**
 * @file CredentialConsentKey.test.ts
 * @description The credential consent record lives in the globalState a local
 * window and every remote window of a profile share, so its keys carry the
 * host scope (#108): a remote host is asked once for itself, and consent
 * recorded before this change keeps matching in a local window.
 */

import * as assert from 'assert';
import { credentialConsentKey } from '../../remediation/CredentialConsentKey';
import { hostScope, HostIdentity, publicFingerprint } from '../../core/TargetOwnershipStore';
import { removeProxyCredentials } from '../../utils/ProxyStateSanitizer';

const URL_WITH_CREDENTIALS = 'http://user:secret@proxy.example.com:3128';
const PUBLIC_URL = 'http://proxy.example.com:3128';
const IDENTITY: HostIdentity = { hostname: 'build-host-7', homedir: '/home/alice', wslDistro: 'Ubuntu-22.04' };

suite('credentialConsentKey (#108)', () => {
    test('the local scope keeps the key earlier versions stored', () => {
        // Today's key: the fingerprint of the address without credentials.
        const todays = publicFingerprint(removeProxyCredentials(URL_WITH_CREDENTIALS) || URL_WITH_CREDENTIALS);
        assert.strictEqual(credentialConsentKey(URL_WITH_CREDENTIALS, ''), todays);
        assert.strictEqual(
            credentialConsentKey(PUBLIC_URL, ''),
            publicFingerprint(removeProxyCredentials(PUBLIC_URL) || PUBLIC_URL)
        );
    });

    test('credentials are not part of the key in any scope', () => {
        const scope = hostScope('ssh-remote', IDENTITY);
        assert.strictEqual(
            credentialConsentKey(URL_WITH_CREDENTIALS, scope),
            credentialConsentKey('http://other:pw@proxy.example.com:3128', scope)
        );
        assert.ok(!credentialConsentKey(URL_WITH_CREDENTIALS, scope).includes('secret'));
    });

    test('a remote scope has a key of its own', () => {
        const remote = credentialConsentKey(URL_WITH_CREDENTIALS, hostScope('ssh-remote', IDENTITY));

        assert.notStrictEqual(remote, credentialConsentKey(URL_WITH_CREDENTIALS, ''));
        assert.ok(/^[0-9a-f]{64}$/.test(remote), 'a digest, never the host identity in plain text');
    });

    test('two remote scopes that differ only in the WSL distribution give different keys', () => {
        assert.notStrictEqual(
            credentialConsentKey(URL_WITH_CREDENTIALS, hostScope('wsl', { ...IDENTITY, wslDistro: 'Ubuntu-22.04' })),
            credentialConsentKey(URL_WITH_CREDENTIALS, hostScope('wsl', { ...IDENTITY, wslDistro: 'Debian' }))
        );
    });

    test('two remote scopes that differ only in the home directory give different keys', () => {
        assert.notStrictEqual(
            credentialConsentKey(URL_WITH_CREDENTIALS, hostScope('ssh-remote', { ...IDENTITY, homedir: '/home/alice' })),
            credentialConsentKey(URL_WITH_CREDENTIALS, hostScope('ssh-remote', { ...IDENTITY, homedir: '/home/bob' }))
        );
    });

    test('different proxy addresses give different keys in the same scope', () => {
        const scope = hostScope('ssh-remote', IDENTITY);
        assert.notStrictEqual(
            credentialConsentKey('http://proxy-a.example.com:3128', scope),
            credentialConsentKey('http://proxy-b.example.com:3128', scope)
        );
    });
});
