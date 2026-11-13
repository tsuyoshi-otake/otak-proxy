/**
 * @file CommandStateCommit
 * @description How a command that prompts the user saves its decision (#135)
 */

import { DecidedPatch, commitDecidedPatch, publishCommitted } from '../core/ApplyConvergence';
import { ProxyState } from '../core/types';
import { CommandContext } from './types';

/**
 * Saves what a command decided onto the latest stored state and tells the
 * other windows. A command that waits for the user (a notification, an input
 * box) must not save the state it read before the wait: a toggle or a sync
 * delivery that landed meanwhile would be rolled back. It passes only the
 * fields it decides; they are folded onto a state read after the wait, by a
 * revision-checked write, refolded when another commit wins the race.
 *
 * The decision is the user's explicit choice, so no logical change of the
 * state in between rejects it. Returns the state that was committed; it can
 * lack hydrated credentials, so a caller that needs the live state re-reads.
 * Throws when every bounded attempt loses the race (nothing was saved), so
 * the command's own error path reports the failure to the user.
 */
export async function commitCommandPatch(ctx: CommandContext, patch: DecidedPatch): Promise<ProxyState> {
    const outcome = await commitDecidedPatch(
        { getState: ctx.getProxyState, commitState: ctx.commitProxyState },
        patch,
        () => true
    );
    if (outcome.kind !== 'committed') {
        throw new Error('The proxy state kept changing while the command was saving; nothing was saved.');
    }

    await publishCommitted(ctx.publishProxyState, outcome.state);
    return outcome.state;
}
