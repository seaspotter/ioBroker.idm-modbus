/** A value of a foreign state as the runners want it. */
export interface ForeignValue {
    /** the value */
    val: ioBroker.StateValue;
    /** time stamp of the value (ms) */
    ts: number;
}

/**
 * Accept a foreign state only when it is confirmed (`ack === true`). A value written with `ack=false` is a command, not a
 * reading, and the same value usually follows again as a confirmed one, so taking both would process it twice.
 *
 * @param state the foreign state as delivered by ioBroker
 * @returns the value for the runners, or null when the state is missing or unconfirmed
 */
export function confirmedValue(
    state: Pick<ioBroker.State, 'val' | 'ts' | 'ack'> | null | undefined,
): ForeignValue | null {
    return state?.ack ? { val: state.val, ts: state.ts } : null;
}
