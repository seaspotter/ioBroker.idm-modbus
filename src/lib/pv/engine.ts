import type { PvSettings, PvSource } from '../config';
import { PV_NEUTRAL_VALUES } from '../constants';

/** The latest value of a foreign state. */
export interface PvInput {
    /** the value as the state holds it */
    val: unknown;
    /** time of the last update in ms */
    ts: number;
}

/** One value to write to the Navigator. */
export interface PvWrite {
    /** register id */
    register: PvSource['register'];
    /** value in the register's unit */
    value: number;
    /** why this value (for the log) */
    note?: string;
}

/** Result of one planning step. */
export interface PvPlan {
    /** values to write now */
    writes: PvWrite[];
    /** registers that were left alone because their source is missing or too old */
    skipped: { register: PvSource['register']; reason: 'stale' | 'invalid' }[];
}

/**
 * Convert a state value for the Navigator: factor, sign, limits. The battery level is an integer percentage.
 *
 * @param source row of the configuration
 * @param input latest state value
 * @param now current time in ms
 * @param maxAgeMs maximum age of the value
 */
export function convertSource(
    source: PvSource,
    input: PvInput | undefined,
    now: number,
    maxAgeMs: number,
): { value: number } | { missing: 'stale' | 'invalid' } {
    if (!input || input.val === null || input.val === undefined || input.val === '') {
        return { missing: 'invalid' };
    }
    const raw = typeof input.val === 'boolean' ? Number(input.val) : Number(input.val);
    if (!Number.isFinite(raw)) {
        return { missing: 'invalid' };
    }
    if (now - input.ts > maxAgeMs) {
        return { missing: 'stale' };
    }
    let value = raw * source.factor * (source.invert ? -1 : 1);
    if (source.min !== null) {
        value = Math.max(source.min, value);
    }
    if (source.max !== null) {
        value = Math.min(source.max, value);
    }
    if (source.register === 'battery_soc') {
        value = Math.min(100, Math.max(0, Math.round(value)));
    }
    return { value: Math.round(value * 1e6) / 1e6 };
}

/**
 * Decide what to write in this cycle. A missing or too old surplus is written as 0 so that the heat pump does not keep
 * running on an old surplus (spec Modul D, a recommendation of the spec, not of IDM); every other register is then simply not
 * written and keeps what the Navigator has.
 *
 * @param settings PV settings
 * @param inputs latest values of the source states, by state id
 * @param now current time in ms
 */
export function planPvWrites(settings: PvSettings, inputs: ReadonlyMap<string, PvInput>, now: number): PvPlan {
    const plan: PvPlan = { writes: [], skipped: [] };
    const converted = new Map<PvSource['register'], ReturnType<typeof convertSource>>();
    for (const source of settings.sources) {
        converted.set(source.register, convertSource(source, inputs.get(source.stateId), now, settings.maxAgeMs));
    }
    const surplusSource = settings.sources.find(s => s.register === 'pv_surplus');
    for (const source of settings.sources) {
        const result = converted.get(source.register);
        if (!result) {
            continue;
        }
        if (source.register === 'pv_surplus' && settings.surplusMode === 'calculated') {
            continue; // calculated below
        }
        if ('value' in result) {
            plan.writes.push({ register: source.register, value: result.value });
        } else {
            // not left out: the Navigator wants every configured value in every cycle (see PV_NEUTRAL_VALUES)
            plan.writes.push({
                register: source.register,
                value: PV_NEUTRAL_VALUES[source.register] ?? 0,
                note: `source ${result.missing}`,
            });
            plan.skipped.push({ register: source.register, reason: result.missing });
        }
    }
    if (settings.surplusMode === 'calculated') {
        const production = converted.get('pv_production');
        const house = converted.get('house_consumption');
        const limits = surplusSource ?? { min: 0, max: null };
        if (production && house && 'value' in production && 'value' in house) {
            let value = production.value - house.value;
            value = Math.max(limits.min ?? 0, value);
            if (limits.max !== null) {
                value = Math.min(limits.max, value);
            }
            plan.writes.unshift({ register: 'pv_surplus', value: Math.round(value * 1e6) / 1e6, note: 'calculated' });
        } else if (production || house) {
            plan.writes.unshift({ register: 'pv_surplus', value: 0, note: 'source missing' });
        }
    }
    return plan;
}
