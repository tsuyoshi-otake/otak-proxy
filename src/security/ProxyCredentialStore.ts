import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import {
    CredentialRef,
    LocalCredentialAvailability,
    ProxyCredentials,
    PublicProxyRef
} from '../core/v3Types';
import { Logger } from '../utils/Logger';

const PROXY_ENV_NAMES = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
];

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

export interface LocalCredentialResolution {
    availability: LocalCredentialAvailability;
    resolvedUrl?: string;
}

function publicUrlsMatch(left: string, right: string): boolean {
    try {
        return normalizePublicUrl(new URL(left)) === normalizePublicUrl(new URL(right));
    } catch {
        return left === right;
    }
}

export function credentialsFromProcessEnv(
    publicUrl: string,
    env: NodeJS.ProcessEnv = process.env
): ProxyCredentials | undefined {
    for (const name of PROXY_ENV_NAMES) {
        const value = env[name];
        if (!value) {
            continue;
        }
        try {
            const split = splitProxyUrl(value);
            if (split.credentials && publicUrlsMatch(split.publicUrl, publicUrl)) {
                return split.credentials;
            }
        } catch {
            // Ignore malformed process-env values.
        }
    }
    return undefined;
}

function hasUsableCredentials(credentials: ProxyCredentials | undefined): boolean {
    return Boolean(credentials?.username || credentials?.password);
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

    async resolveLocalCredentials(
        publicUrl: string,
        required: boolean,
        env: NodeJS.ProcessEnv = process.env
    ): Promise<LocalCredentialResolution> {
        if (!publicUrl) {
            return { availability: 'notRequired' };
        }

        try {
            const embedded = splitProxyUrl(publicUrl);
            if (hasUsableCredentials(embedded.credentials)) {
                return { availability: 'availableOnThisMachine', resolvedUrl: publicUrl };
            }
        } catch {
            // Treat unparsable values as public endpoints.
        }

        const fromEnv = credentialsFromProcessEnv(publicUrl, env);
        if (fromEnv) {
            return {
                availability: 'availableOnThisMachine',
                resolvedUrl: buildProxyUrlWithCredentials(publicUrl, fromEnv)
            };
        }

        if (!required) {
            return { availability: 'notRequired' };
        }

        if (!this.secrets) {
            return { availability: 'secretStorageUnavailable' };
        }

        try {
            const stored = await this.getCredentialsForPublicUrl(publicUrl);
            if (hasUsableCredentials(stored)) {
                return {
                    availability: 'availableOnThisMachine',
                    resolvedUrl: buildProxyUrlWithCredentials(publicUrl, stored!)
                };
            }
            if (stored) {
                return { availability: 'needsReEntry' };
            }
        } catch {
            return { availability: 'needsReEntry' };
        }

        return { availability: 'missingOnThisMachine' };
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
