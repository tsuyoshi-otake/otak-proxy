export const UNREADABLE = Symbol('unreadable');

export type PartialWriteAction = 'cleared' | 'restored' | 'conflict' | 'residual' | 'absent' | 'unchanged';

export interface PartialWriteKeyResult<K extends string> {
    key: K;
    action: PartialWriteAction;
}

export interface PartialWriteCompensation<K extends string> {
    keys: PartialWriteKeyResult<K>[];
    residualKeys: K[];
    conflictedKeys: K[];
    summary: string;
}

export interface CompensatePartialProxyWriteInput<K extends string> {
    writtenKeys: readonly K[];
    writtenValue: string;
    snapshot: Partial<Record<K, string | null>> | undefined;
    readCurrent: (key: K) => Promise<string | null | typeof UNREADABLE>;
    restore: (key: K, previous: string) => Promise<void>;
    clear: (key: K) => Promise<void>;
}

export function summarizePartialWriteCompensation<K extends string>(
    failedKey: string | undefined,
    compensation: Pick<PartialWriteCompensation<K>, 'keys' | 'residualKeys' | 'conflictedKeys'>
): string {
    const parts: string[] = [];
    if (failedKey) {
        parts.push(`${failedKey} write failed`);
    }
    const compensated = compensation.keys
        .filter(entry => entry.action === 'cleared' || entry.action === 'restored')
        .map(entry => entry.key);
    if (compensated.length > 0) {
        parts.push(`compensated ${compensated.join(', ')}`);
    }
    if (compensation.conflictedKeys.length > 0) {
        parts.push(`left unchanged after external change: ${compensation.conflictedKeys.join(', ')}`);
    }
    if (compensation.residualKeys.length > 0) {
        parts.push(`residual remains: ${compensation.residualKeys.join(', ')}`);
    }
    return parts.join('; ');
}

export function getPartialWriteCompensation<K extends string>(error: unknown): PartialWriteCompensation<K> | undefined {
    if (typeof error !== 'object' || error === null || !('otakPartialWrite' in error)) {
        return undefined;
    }
    return (error as { otakPartialWrite?: PartialWriteCompensation<K> }).otakPartialWrite;
}

/**
 * After a later key write fails, restore or clear only the values this call
 * introduced. Never overwrite a value that no longer matches what we wrote.
 */
export async function compensatePartialProxyWrite<K extends string>(
    input: CompensatePartialProxyWriteInput<K>
): Promise<PartialWriteCompensation<K>> {
    const keys: PartialWriteKeyResult<K>[] = [];
    const residualKeys: K[] = [];
    const conflictedKeys: K[] = [];

    for (const key of input.writtenKeys) {
        const previous = input.snapshot?.[key] ?? null;
        const introduced = input.snapshot === undefined || previous !== input.writtenValue;
        if (!introduced) {
            keys.push({ key, action: 'unchanged' });
            continue;
        }

        const current = await input.readCurrent(key);
        if (current === UNREADABLE) {
            residualKeys.push(key);
            keys.push({ key, action: 'residual' });
            continue;
        }
        if (current === null) {
            keys.push({ key, action: 'absent' });
            continue;
        }
        if (current !== input.writtenValue) {
            conflictedKeys.push(key);
            keys.push({ key, action: 'conflict' });
            continue;
        }

        try {
            if (previous) {
                await input.restore(key, previous);
                const after = await input.readCurrent(key);
                if (after !== previous) {
                    throw new Error('restore verify failed');
                }
                keys.push({ key, action: 'restored' });
                continue;
            }

            await input.clear(key);
            const after = await input.readCurrent(key);
            if (after === input.writtenValue || after === UNREADABLE) {
                throw new Error('clear verify failed');
            }
            keys.push({ key, action: 'cleared' });
        } catch {
            residualKeys.push(key);
            keys.push({ key, action: 'residual' });
        }
    }

    return {
        keys,
        residualKeys,
        conflictedKeys,
        summary: summarizePartialWriteCompensation(undefined, { keys, residualKeys, conflictedKeys })
    };
}
