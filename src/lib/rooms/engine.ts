import type { RoomSource } from '../config';
import type { ForeignState } from '../runner-kit';

/** What the last write of a row was. */
export interface LastRoomWrite {
    /** value in °C */
    value: number;
    /** time in ms */
    at: number;
}

/** Decision for one row. */
export type RoomDecision =
    | { write: number; reason: 'first' | 'changed' | 'heartbeat' | 'fixed' }
    | { skip: 'invalid' | 'stale' | 'range' | 'unchanged' };

/**
 * Decide whether a heating circuit's room temperature is written now (spec Modul C): immediately on a change of at least the
 * tolerance, otherwise at the heartbeat. Values outside the range are never written; an old source stops the writing or writes
 * the configured fixed value.
 *
 * @param row configuration of the heating circuit
 * @param input the latest source value
 * @param now current time in ms
 * @param last the previous write
 */
export function decideRoomWrite(
    row: RoomSource,
    input: ForeignState | undefined,
    now: number,
    last: LastRoomWrite | undefined,
): RoomDecision {
    const due = (value: number, reason: 'changed' | 'fixed'): RoomDecision => {
        if (!last) {
            return { write: value, reason: reason === 'fixed' ? 'fixed' : 'first' };
        }
        if (Math.abs(value - last.value) >= row.toleranceC - 1e-9) {
            return { write: value, reason };
        }
        return now - last.at >= row.heartbeatMs ? { write: value, reason: 'heartbeat' } : { skip: 'unchanged' };
    };
    const raw = input && input.val !== null && input.val !== '' ? Number(input.val) : NaN;
    if (!Number.isFinite(raw)) {
        return { skip: 'invalid' };
    }
    if (now - input!.ts > row.maxAgeMs) {
        return row.onStale === 'fixed' && row.fixedValue !== null ? due(row.fixedValue, 'fixed') : { skip: 'stale' };
    }
    const value = Math.round((raw * row.factor + row.offset) * 10) / 10;
    if (value < row.min || value > row.max) {
        return { skip: 'range' };
    }
    return due(value, 'changed');
}
