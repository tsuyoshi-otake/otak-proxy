/**
 * Key of one credential consent record. The record lives in the globalState a
 * local window and every remote window of a profile share, so the key carries
 * the host scope (see hostScope): a remote host is asked once for itself.
 * The local scope returns the key earlier versions stored, so consent given
 * before the scope existed keeps covering the local window (#108).
 */
import * as crypto from 'crypto';
import { publicFingerprint } from '../core/TargetOwnershipStore';
import { removeProxyCredentials } from '../utils/ProxyStateSanitizer';

export function credentialConsentKey(url: string, scope: string): string {
    const publicUrl = removeProxyCredentials(url) || url;
    if (!scope) {
        return publicFingerprint(publicUrl);
    }
    return crypto.createHash('sha256').update(`${scope}\0${publicUrl}`).digest('hex');
}
