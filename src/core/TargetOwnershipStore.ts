import * as crypto from 'crypto';
import type * as vscode from 'vscode';
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

export class TargetOwnershipStore {
    constructor(
        private readonly globalState: vscode.Memento,
        private readonly credentialStore: ProxyCredentialStore
    ) {}

    getAll(): Record<string, TargetOwnership> {
        return this.globalState.get<Record<string, TargetOwnership>>(OWNERSHIP_KEY, {});
    }

    get(targetId: string): TargetOwnership | undefined {
        return this.getAll()[targetId];
    }

    async update(ownership: TargetOwnership): Promise<void> {
        const all = this.getAll();
        all[ownership.targetId] = ownership;
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

    async isOwnedByOtakProxy(targetId: string, observedValue: string, secretBearing: boolean): Promise<boolean> {
        const ownership = this.get(targetId);
        if (!ownership || ownership.owner !== 'otakProxy') {
            return false;
        }

        if (secretBearing) {
            if (!ownership.secretAwareFingerprint || !(await this.credentialStore.hasHmacKey())) {
                return false;
            }
            const observedSecretFingerprint = await this.credentialStore.computeSecretAwareFingerprint(observedValue);
            return observedSecretFingerprint === ownership.secretAwareFingerprint;
        }

        return ownership.publicFingerprint === publicFingerprint(observedValue);
    }
}
