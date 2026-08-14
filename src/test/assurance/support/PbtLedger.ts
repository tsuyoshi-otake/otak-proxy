import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PbtRunRecord {
    schemaVersion: 1;
    runId: string;
    propertyId: string;
    status: 'passed' | 'failed' | 'calibrated';
    seed: number;
    path: string | null;
    numRuns: number;
    numSkips: number;
    numShrinks: number;
    generatorVersion: string;
    counterexample: unknown | null;
    counterexamplePath: string | null;
    failure: string | null;
    requirements: readonly string[];
    tool: { name: 'fast-check'; version: string };
    source: { commit: string; worktreeFingerprint: string };
    redaction: 'safe-token-v1';
}

interface FastCheckResultLike {
    failed?: boolean;
    seed?: number;
    counterexamplePath?: string | null;
    counterexample?: unknown;
    numRuns?: number;
    numSkips?: number;
    numShrinks?: number;
    error?: unknown;
}

let sequence = 0;

export function getAssuranceEvidenceRoot(): string {
    return process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ||
        path.join(os.tmpdir(), 'otak-proxy-assurance-evidence');
}

export function nextRunId(propertyId: string): string {
    sequence += 1;
    const now = new Date().toISOString().replace(/[-:.TZ]/g, '');
    return `${now}-${propertyId}-${process.pid}-${sequence}-${randomUUID().slice(0, 8)}`;
}

function redactString(value: string): string {
    return value
        .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
        .replace(/((?:token|password|secret|credential)[^=:\s]{0,32}[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

export function redactForEvidence(value: unknown, key = ''): unknown {
    if (typeof value === 'string') {
        return /(token|password|secret|credential)/iu.test(key) ? '[REDACTED]' : redactString(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => redactForEvidence(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
            entryKey,
            redactForEvidence(entryValue, entryKey)
        ]));
    }
    return value;
}

function sourceFingerprint(): PbtRunRecord['source'] {
    const commit = process.env.GITHUB_SHA || process.env.OTAK_PROXY_ASSURANCE_COMMIT || 'working-tree';
    const worktreeFingerprint = createHash('sha256')
        .update(`${process.cwd()}\u0000${commit}\u0000${process.env.CI ?? 'local'}`)
        .digest('hex')
        .slice(0, 16);
    return { commit, worktreeFingerprint };
}

export function recordFromFastCheck(
    propertyId: string,
    result: FastCheckResultLike,
    generatorVersion: string,
    requirements: readonly string[],
    status: PbtRunRecord['status'] = result.failed ? 'failed' : 'passed'
): PbtRunRecord {
    const failed = Boolean(result.failed);
    const counterexample = failed ? redactForEvidence(result.counterexample) : null;
    return {
        schemaVersion: 1,
        runId: nextRunId(propertyId),
        propertyId,
        status,
        seed: Number(result.seed ?? 0),
        path: failed && result.counterexamplePath ? String(result.counterexamplePath) : null,
        numRuns: Number(result.numRuns ?? 0),
        numSkips: Number(result.numSkips ?? 0),
        numShrinks: Number(result.numShrinks ?? 0),
        generatorVersion,
        counterexample,
        counterexamplePath: failed && result.counterexamplePath ? String(result.counterexamplePath) : null,
        failure: failed ? redactString(String(result.error ?? 'property failed')) : null,
        requirements,
        tool: { name: 'fast-check', version: '4.x' },
        source: sourceFingerprint(),
        redaction: 'safe-token-v1'
    };
}

export async function writePbtRecord(record: PbtRunRecord, evidenceRoot = getAssuranceEvidenceRoot()): Promise<string> {
    const directory = path.join(evidenceRoot, 'pbt');
    await fs.mkdir(directory, { recursive: true });
    const outputPath = path.join(directory, `${record.runId}.json`);
    const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(redactForEvidence(record), null, 2)}\n`;
    await fs.writeFile(temporaryPath, serialized, 'utf8');
    await fs.rename(temporaryPath, outputPath);
    return outputPath;
}

export async function listPbtRecords(evidenceRoot = getAssuranceEvidenceRoot()): Promise<PbtRunRecord[]> {
    const directory = path.join(evidenceRoot, 'pbt');
    try {
        const names = await fs.readdir(directory);
        const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
            const body = await fs.readFile(path.join(directory, name), 'utf8');
            return JSON.parse(body) as PbtRunRecord;
        }));
        return records;
    } catch (error: unknown) {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}
