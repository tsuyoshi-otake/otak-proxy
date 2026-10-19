import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import {
    OwnershipOwner,
    TargetHost,
    TargetOwnership
} from './v3Types';
import { ProxyCredentialStore } from '../security/ProxyCredentialStore';

const OWNERSHIP_KEY = 'otakProxy.v3.localTargetOwnership';

export interface TargetSnapshot {
    targetId: string;
    targetHost: TargetHost;
    value?: string | null;
    owner?: OwnershipOwner;
}

export function publicFingerprint(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export type TargetOwnershipVerdict = 'owned' | 'external' | 'unverifiable';

/** What tells two remote hosts of the same kind apart. */
export interface HostIdentity {
    hostname: string;
    homedir: string;
    /** `WSL_DISTRO_NAME`; unset digests as the empty string. */
    wslDistro?: string;
}

/**
 * Which host a window's records belong to. A remote workspace extension's
 * globalState is the local window's profile storage, so a local window and
 * every remote window of the profile read and write the same map; records and
 * consent keys carry this scope to stay apart. The local scope is the empty
 * string, so records and consent written before the scope existed keep their
 * keys. A remote scope is the remote name plus a digest of the host identity:
 * the host name alone is the same for every WSL distribution of one machine and
 * for two users of one SSH host, and none of it is stored in plain text.
 */
export function hostScope(remoteName: string | undefined, identity: HostIdentity): string {
    if (!remoteName) {
        return '';
    }
    const digest = crypto
        .createHash('sha256')
        .update([identity.hostname, identity.homedir, identity.wslDistro ?? ''].join('\0'))
        .digest('hex')
        .slice(0, 12);
    return `${remoteName}:${digest}`;
}

/** The scope of the window this extension host serves. */
export function currentHostScope(): string {
    return hostScope(vscode.env.remoteName, {
        hostname: os.hostname(),
        homedir: os.homedir(),
        wslDistro: process.env.WSL_DISTRO_NAME
    });
}

export class TargetOwnershipStore {
    constructor(
        private readonly globalState: vscode.Memento,
        private readonly credentialStore: ProxyCredentialStore,
        private readonly scope: string = currentHostScope()
    ) {}

    private getAll(): Record<string, TargetOwnership> {
        return this.globalState.get<Record<string, TargetOwnership>>(OWNERSHIP_KEY, {});
    }

    private recordKey(targetId: string): string {
        return this.scope ? `${this.scope}|${targetId}` : targetId;
    }

    get(targetId: string): TargetOwnership | undefined {
        return this.getAll()[this.recordKey(targetId)];
    }

    async update(ownership: TargetOwnership): Promise<void> {
        const all = this.getAll();
        all[this.recordKey(ownership.targetId)] = ownership;
        await this.globalState.update(OWNERSHIP_KEY, all);
    }

    async remove(targetId: string): Promise<void> {
        const all = this.getAll();
        const key = this.recordKey(targetId);
        if (!(key in all)) {
            return;
        }
        delete all[key];
        await this.globalState.update(OWNERSHIP_KEY, all);
    }

    async bootstrapFromSnapshot(
        intendedPublicValue: string,
        snapshots: readonly TargetSnapshot[],
        intendedFullValue?: string
    ): Promise<TargetOwnership[]> {
        const bootstrapped: TargetOwnership[] = [];
        const publicHash = publicFingerprint(intendedPublicValue);
        const secretHash = intendedFullValue
            ? await this.credentialStore.computeSecretAwareFingerprint(intendedFullValue)
            : undefined;

        for (const snapshot of snapshots) {
            if (!snapshot.value || snapshot.value !== intendedPublicValue) {
                await this.update({
                    targetId: snapshot.targetId,
                    targetHost: snapshot.targetHost,
                    owner: snapshot.owner ?? 'external',
                    lastObservedHash: snapshot.value ? publicFingerprint(snapshot.value) : undefined,
                    lastObservedAt: Date.now()
                });
                continue;
            }

            const ownership: TargetOwnership = {
                targetId: snapshot.targetId,
                targetHost: snapshot.targetHost,
                owner: 'otakProxy',
                publicFingerprint: publicHash,
                secretAwareFingerprint: secretHash,
                fingerprintKeyRef: secretHash ? 'otakProxy.v3.hmacKey' : undefined,
                lastSuccessfulApplyAt: Date.now(),
                lastObservedHash: publicHash,
                lastObservedAt: Date.now()
            };
            await this.update(ownership);
            bootstrapped.push(ownership);
        }

        return bootstrapped;
    }

    /**
     * Whether an observed target value is one otak-proxy wrote. `unverifiable`
     * means a record naming otak-proxy exists but the secret-aware fingerprint
     * or the HMAC key needed to compare a credential-bearing value is missing:
     * the value may well be ours, so a caller must keep it and say so rather
     * than treat it as someone else's.
     */
    async inspectOwnership(
        targetId: string,
        observedValue: string,
        secretBearing: boolean
    ): Promise<TargetOwnershipVerdict> {
        const ownership = this.get(targetId);
        if (!ownership || ownership.owner !== 'otakProxy') {
            return 'external';
        }

        if (secretBearing) {
            if (!ownership.secretAwareFingerprint || !(await this.credentialStore.hasHmacKey())) {
                return 'unverifiable';
            }
            const observedSecretFingerprint = await this.credentialStore.computeSecretAwareFingerprint(observedValue);
            return observedSecretFingerprint === ownership.secretAwareFingerprint ? 'owned' : 'external';
        }

        return ownership.publicFingerprint === publicFingerprint(observedValue) ? 'owned' : 'external';
    }
}
