import * as vscode from 'vscode';
import { ProxyState } from './types';
import {
    MigrationJournal,
    MigrationPhase,
    V3_SCHEMA_VERSION
} from './v3Types';
import { TargetOwnershipStore, TargetSnapshot } from './TargetOwnershipStore';
import { ProxyCredentialStore, splitProxyUrl } from '../security/ProxyCredentialStore';
import {
    hasProxyCredentials,
    removeProxyCredentials,
    sanitizeProxyStateForPersistence
} from '../utils/ProxyStateSanitizer';
import { ProxySecretRedactor } from '../security/ProxySecretRedactor';
import { Logger } from '../utils/Logger';

export const V3_SCHEMA_VERSION_KEY = 'otakProxy.v3.schemaVersion';
export const V3_MIGRATION_JOURNAL_KEY = 'otakProxy.v3.migrationJournal';
export const LEGACY_MANUAL_PROXY_SECRET_KEY = 'otakProxy.manualProxyUrl';

function isCompleted(journal: MigrationJournal | undefined, schemaVersion: number): boolean {
    return schemaVersion >= V3_SCHEMA_VERSION && journal?.phase === 'completed';
}

export class V3MigrationService {
    private readonly credentialStore: ProxyCredentialStore;
    private readonly ownershipStore: TargetOwnershipStore;
    private readonly redactor = new ProxySecretRedactor();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.credentialStore = new ProxyCredentialStore(context.secrets);
        this.ownershipStore = new TargetOwnershipStore(context.globalState, this.credentialStore);
    }

    async migrateIfNeeded(): Promise<MigrationJournal> {
        const schemaVersion = this.context.globalState.get<number>(V3_SCHEMA_VERSION_KEY, 0);
        const existingJournal = this.context.globalState.get<MigrationJournal>(V3_MIGRATION_JOURNAL_KEY);
        if (isCompleted(existingJournal, schemaVersion)) {
            return existingJournal!;
        }

        let journal = existingJournal ?? this.createJournal(schemaVersion);
        try {
            const state = this.context.globalState.get<ProxyState>('proxyState');
            const configuredUrl = vscode.workspace.getConfiguration('otakProxy').get<string>('proxyUrl', '');
            const legacySecret = await this.readLegacySecret();
            const credentialCandidate = this.findCredentialCandidate(state, configuredUrl, legacySecret);
            let credentialPublicUrl: string | undefined;
            let credentialFullUrl: string | undefined;

            if (credentialCandidate) {
                const ref = await this.credentialStore.storeFromProxyUrl(credentialCandidate);
                credentialFullUrl = credentialCandidate;
                credentialPublicUrl = splitProxyUrl(credentialCandidate).publicUrl;
                journal = await this.saveJournal({
                    ...journal,
                    phase: 'secretStored',
                    migratedCredentialRef: ref?.key,
                    lastErrorSanitized: ref ? undefined : 'SecretStorage unavailable; credentials require re-entry'
                });
            }

            await this.writePublicState(state, configuredUrl);
            journal = await this.saveJournal({ ...journal, phase: 'publicStateWritten' });

            await this.deleteLegacySecret();
            journal = await this.saveJournal({
                ...journal,
                phase: 'legacySecretScrubbed',
                legacySecretKeyNames: [LEGACY_MANUAL_PROXY_SECRET_KEY]
            });

            await this.bootstrapOwnership(credentialPublicUrl, credentialFullUrl);
            journal = await this.saveJournal({ ...journal, phase: 'ownershipBootstrapped' });

            await this.context.globalState.update(V3_SCHEMA_VERSION_KEY, V3_SCHEMA_VERSION);
            journal = await this.saveJournal({ ...journal, phase: 'completed' });
            return journal;
        } catch (error) {
            const sanitized = this.redactor.redactString(error instanceof Error ? error.message : String(error));
            Logger.warn('v3 migration failed:', sanitized);
            journal = await this.saveJournal({
                ...journal,
                phase: 'failed',
                lastErrorSanitized: sanitized
            });
            return journal;
        }
    }

    private createJournal(schemaFrom: number): MigrationJournal {
        return {
            schemaFrom,
            schemaTo: V3_SCHEMA_VERSION,
            phase: 'notStarted'
        };
    }

    private async saveJournal(journal: MigrationJournal): Promise<MigrationJournal> {
        try {
            await this.context.globalState.update(V3_MIGRATION_JOURNAL_KEY, journal);
        } catch (error) {
            Logger.warn('Failed to persist v3 migration journal:', error);
        }
        return journal;
    }

    private findCredentialCandidate(
        state: ProxyState | undefined,
        configuredUrl: string,
        legacySecret: string | undefined
    ): string | undefined {
        const candidates = [
            state?.manualProxyUrl,
            state?.autoProxyUrl,
            configuredUrl,
            legacySecret,
            state?.lastSystemProxyUrl,
            state?.fallbackProxyUrl
        ];
        return candidates.find((candidate): candidate is string => Boolean(candidate && hasProxyCredentials(candidate)));
    }

    private async writePublicState(state: ProxyState | undefined, configuredUrl: string): Promise<void> {
        if (state) {
            await this.context.globalState.update('proxyState', sanitizeProxyStateForPersistence(state));
        }

        if (configuredUrl && hasProxyCredentials(configuredUrl)) {
            await vscode.workspace.getConfiguration('otakProxy').update(
                'proxyUrl',
                removeProxyCredentials(configuredUrl),
                vscode.ConfigurationTarget.Global
            );
        }
    }

    private async deleteLegacySecret(): Promise<void> {
        try {
            await this.context.secrets?.delete(LEGACY_MANUAL_PROXY_SECRET_KEY);
        } catch (error) {
            Logger.warn('Failed to delete legacy manual proxy secret:', error);
        }
    }

    private async readLegacySecret(): Promise<string | undefined> {
        try {
            return await this.context.secrets?.get(LEGACY_MANUAL_PROXY_SECRET_KEY);
        } catch (error) {
            Logger.warn('Failed to read legacy manual proxy secret:', error);
            return undefined;
        }
    }

    private async bootstrapOwnership(publicUrl: string | undefined, fullUrl: string | undefined): Promise<void> {
        if (!publicUrl) {
            return;
        }

        const snapshots = this.getCheapSnapshots(publicUrl);
        await this.ownershipStore.bootstrapFromSnapshot(publicUrl, snapshots, fullUrl);
    }

    private getCheapSnapshots(publicUrl: string): TargetSnapshot[] {
        const httpConfig = vscode.workspace.getConfiguration('http');
        const vscodeProxy = httpConfig.get<string>('proxy');
        return [{
            targetId: 'vscode.http.proxy',
            targetHost: 'workspaceHost',
            value: vscodeProxy === publicUrl ? publicUrl : vscodeProxy,
            owner: vscodeProxy === publicUrl ? 'otakProxy' : 'external'
        }];
    }
}

export function isMigrationTerminalPhase(phase: MigrationPhase): boolean {
    return phase === 'completed' || phase === 'failed';
}
