/**
 * Compare-then-delete for backends that only expose key-level unset.
 *
 * Not a second ownership model: callers still decide ownership via
 * TargetOwnershipStore, then pass the observed owned value here.
 *
 * Non-guarantee: an external writer that mutates the key during the
 * delete/update syscall itself cannot be recovered. We never saw the
 * replacement value, so we cannot restore it.
 */

export const UNSET_UNREADABLE = Symbol('UNSET_UNREADABLE');

export async function compareThenDelete(args: {
    expected: string;
    read: () => Promise<string | null | typeof UNSET_UNREADABLE>;
    deleteKey: () => Promise<void>;
}): Promise<
    | { ok: true; skipped: boolean; preserved: boolean }
    | { ok: false; reason: 'unreadable' | 'ownedValueRemained' }
> {
    const before = await args.read();
    if (before === UNSET_UNREADABLE) {
        return { ok: false, reason: 'unreadable' };
    }
    if (before !== args.expected) {
        return { ok: true, skipped: true, preserved: before !== null };
    }

    await args.deleteKey();

    const after = await args.read();
    if (after === UNSET_UNREADABLE) {
        return { ok: false, reason: 'unreadable' };
    }
    if (after === args.expected) {
        return { ok: false, reason: 'ownedValueRemained' };
    }
    return { ok: true, skipped: false, preserved: after !== null };
}
