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
import { I18nManager } from '../i18n/I18nManager';
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
            const credentialCandidates = this.findCredentialCandidates(state, configuredUrl, legacySecret);
            let credentialPublicUrl: string | undefined;
            let credentialFullUrl: string | undefined;
            let droppedCredentialCount = 0;

            if (credentialCandidates.length > 0) {
                const stored = await this.migrateCredentials(credentialCandidates);
                credentialFullUrl = stored.primaryFullUrl;
                credentialPublicUrl = stored.primaryPublicUrl;
                droppedCredentialCount = stored.droppedCount;
                journal = await this.saveJournal({
                    ...journal,
                    phase: 'secretStored',
                    migratedCredentialRef: stored.refs[0],
                    migratedCredentialRefs: stored.refs.length > 0 ? stored.refs : undefined,
                    droppedCredentialCount: stored.droppedCount > 0 ? stored.droppedCount : undefined,
                    // Set on ANY store failure (not only total failure) so a partial
                    // SecretStorage outage that lost some credentials is still recorded.
                    lastErrorSanitized: stored.secretStorageUnavailable
                        ? 'SecretStorage unavailable; some credentials require re-entry'
                        : undefined
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
            // Notify only after the schema version is committed, so a failure in a
            // later phase (which re-runs migration next time) cannot warn twice.
            if (droppedCredentialCount > 0) {
                this.notifyDroppedCredentials(droppedCredentialCount);
            }
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

    private findCredentialCandidates(
        state: ProxyState | undefined,
        configuredUrl: string,
        legacySecret: string | undefined
    ): string[] {
        // Priority order: the first credential-bearing URL is the "primary" one
        // used for ownership bootstrap and wins any shared-address collision.
        const candidates = [
            state?.manualProxyUrl,
            state?.autoProxyUrl,
            configuredUrl,
            legacySecret,
            state?.lastSystemProxyUrl,
            state?.fallbackProxyUrl
        ];
        return candidates.filter((candidate): candidate is string => Boolean(candidate && hasProxyCredentials(candidate)));
    }

    /**
     * Stores each distinct credential-bearing URL under its own secret (keyed by
     * public URL). A v2 user could hold differently-credentialed URLs in more than
     * one field; migrating only the first (as before) silently discarded the rest.
     * Two fields sharing the same public URL but different logins collide on one
     * key: the first (highest priority) wins and the loss is counted for the journal.
     */
    private async migrateCredentials(candidates: string[]): Promise<{
        refs: string[];
        primaryPublicUrl?: string;
        primaryFullUrl?: string;
        droppedCount: number;
        secretStorageUnavailable: boolean;
    }> {
        const refs: string[] = [];
        const storedCredentialByPublicUrl = new Map<string, string>();
        // Distinct (public URL + losing login) pairs, so two fields carrying the
        // identical alternate login are not counted twice.
        const droppedCredentialKeys = new Set<string>();
        let primaryPublicUrl: string | undefined;
        let primaryFullUrl: string | undefined;
        let secretStorageUnavailable = false;

        for (const candidate of candidates) {
            try {
                const split = splitProxyUrl(candidate);
                const credentialJson = JSON.stringify(split.credentials ?? {});
                const alreadyStored = storedCredentialByPublicUrl.get(split.publicUrl);
                if (alreadyStored !== undefined) {
                    // Same proxy address as an earlier field. Only a real loss if the
                    // login differs (identical duplicates cost nothing).
                    if (alreadyStored !== credentialJson) {
                        droppedCredentialKeys.add(`${split.publicUrl}\n${credentialJson}`);
                    }
                    continue;
                }

                const ref = await this.credentialStore.storeFromProxyUrl(candidate);
                if (!ref) {
                    secretStorageUnavailable = true;
                    continue;
                }
                storedCredentialByPublicUrl.set(split.publicUrl, credentialJson);
                refs.push(ref.key);
                if (!primaryPublicUrl) {
                    primaryPublicUrl = split.publicUrl;
                    primaryFullUrl = candidate;
                }
            } catch (error) {
                // hasProxyCredentials() can pass a value that new URL() rejects
                // (e.g. "http://user:pass@" with no host). Skip that one malformed
                // field instead of aborting migration of the valid ones; it is
                // stripped from public state regardless.
                Logger.warn(
                    'Skipping unparseable credential-bearing field during migration:',
                    this.redactor.redactString(error instanceof Error ? error.message : String(error))
                );
            }
        }

        return {
            refs,
            primaryPublicUrl,
            primaryFullUrl,
            droppedCount: droppedCredentialKeys.size,
            secretStorageUnavailable
        };
    }

    private notifyDroppedCredentials(count: number): void {
        try {
            const message = I18nManager.getInstance().t('migration.credentialsDropped', { count: String(count) });
            // Fire-and-forget: do not block migration on the user dismissing the
            // dialog, but still swallow any rejection so it is not unhandled.
            Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => undefined);
        } catch (error) {
            Logger.warn('Failed to notify about dropped proxy credentials:', error);
        }
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
