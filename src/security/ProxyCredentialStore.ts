import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import {
    CredentialRef,
    ProxyCredentials,
    PublicProxyRef
} from '../core/v3Types';
import { Logger } from '../utils/Logger';

const CREDENTIAL_PREFIX = 'otakProxy.v3.credentials.';
const HMAC_KEY = 'otakProxy.v3.hmacKey';

function decodeUrlPart(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePublicUrl(parsed: URL): string {
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
}

export interface SplitProxyUrlResult {
    publicUrl: string;
    publicRef: PublicProxyRef;
    credentials?: ProxyCredentials;
}

export function splitProxyUrl(rawUrl: string): SplitProxyUrlResult {
    const parsed = new URL(rawUrl);
    const credentials: ProxyCredentials | undefined = parsed.username || parsed.password
        ? {
            username: decodeUrlPart(parsed.username),
            password: decodeUrlPart(parsed.password)
        }
        : undefined;
    const publicUrl = normalizePublicUrl(new URL(rawUrl));
    return {
        publicUrl,
        publicRef: {
            kind: 'singleProxy',
            scheme: parsed.protocol.replace(/:$/, ''),
            host: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : undefined,
            path: parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : undefined,
            publicUrl
        },
        credentials
    };
}

export function getCredentialKeyForPublicUrl(publicUrl: string): string {
    return `${CREDENTIAL_PREFIX}${sha256(publicUrl)}`;
}

export function buildProxyUrlWithCredentials(publicUrl: string, credentials: ProxyCredentials): string {
    const parsed = new URL(publicUrl);
    if (credentials.username) {
        parsed.username = credentials.username;
    }
    if (credentials.password) {
        parsed.password = credentials.password;
    }
    const reconstructed = parsed.toString();
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
        return reconstructed.slice(0, -1);
    }
    return reconstructed;
}

export class ProxyCredentialStore {
    constructor(private readonly secrets: vscode.SecretStorage | undefined) {}

    async storeFromProxyUrl(rawUrl: string): Promise<CredentialRef | undefined> {
        const split = splitProxyUrl(rawUrl);
        if (!split.credentials) {
            return undefined;
        }
        const key = getCredentialKeyForPublicUrl(split.publicUrl);
        const stored = await this.storeJson(key, split.credentials);
        if (!stored) {
            return undefined;
        }
        return { key, publicUrl: split.publicUrl };
    }

    async getCredentials(ref: CredentialRef): Promise<ProxyCredentials | undefined> {
        return this.getJson<ProxyCredentials>(ref.key);
    }

    async getCredentialsForPublicUrl(publicUrl: string): Promise<ProxyCredentials | undefined> {
        return this.getJson<ProxyCredentials>(getCredentialKeyForPublicUrl(publicUrl));
    }

    async reconstructProxyUrl(publicUrl: string): Promise<string | undefined> {
        const credentials = await this.getCredentialsForPublicUrl(publicUrl);
        if (!credentials) {
            return undefined;
        }
        return buildProxyUrlWithCredentials(publicUrl, credentials);
    }

    async deleteCredentialsForPublicUrl(publicUrl: string): Promise<void> {
        if (!this.secrets) {
            return;
        }
        await this.secrets.delete(getCredentialKeyForPublicUrl(publicUrl));
    }

    async computeSecretAwareFingerprint(value: string): Promise<string | undefined> {
        const key = await this.getOrCreateHmacKey();
        if (!key) {
            return undefined;
        }
        return crypto.createHmac('sha256', key).update(value).digest('hex');
    }

    async hasHmacKey(): Promise<boolean> {
        if (!this.secrets) {
            return false;
        }
        try {
            return Boolean(await this.secrets.get(HMAC_KEY));
        } catch {
            return false;
        }
    }

    private async getOrCreateHmacKey(): Promise<string | undefined> {
        if (!this.secrets) {
            Logger.warn('Secret storage is not available; cannot create v3 HMAC key.');
            return undefined;
        }

        try {
            const existing = await this.secrets.get(HMAC_KEY);
            if (existing) {
                return existing;
            }
            const generated = crypto.randomBytes(32).toString('base64');
            await this.secrets.store(HMAC_KEY, generated);
            return generated;
        } catch (error) {
            Logger.warn('Failed to access v3 HMAC key in SecretStorage:', error);
            return undefined;
        }
    }

    private async storeJson(key: string, value: unknown): Promise<boolean> {
        if (!this.secrets) {
            Logger.warn('Secret storage is not available; proxy credentials cannot be stored securely.');
            return false;
        }
        try {
            await this.secrets.store(key, JSON.stringify(value));
            return true;
        } catch (error) {
            Logger.warn('Failed to store proxy credentials in SecretStorage:', error);
            return false;
        }
    }

    private async getJson<T>(key: string): Promise<T | undefined> {
        if (!this.secrets) {
            return undefined;
        }
        try {
            const raw = await this.secrets.get(key);
            return raw ? JSON.parse(raw) as T : undefined;
        } catch (error) {
            Logger.warn('Failed to read proxy credentials from SecretStorage:', error);
            return undefined;
        }
    }
}
