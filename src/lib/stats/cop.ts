import { type Bucket, type ElectricalSource, sumModes } from './types';

/** Below this electrical power the pump is in standby or commissioning; a COP would be a meaningless ratio. */
export const COP_MIN_ELECTRICAL_KW = 0.05;
/** A momentary COP above this is a measurement artefact of the Navigator's flow/spread calculation. */
export const COP_MAX_PLAUSIBLE = 15;
/** A period needs at least this much electrical energy before its COP is reported. */
export const COP_MIN_PERIOD_KWH = 0.1;

/**
 * A ratio as COP with two decimals, or no value above the plausible maximum.
 *
 * @param thermal heat
 * @param electrical electricity
 */
function ratio(thermal: number, electrical: number): number | null {
    const cop = thermal / electrical;
    return cop > COP_MAX_PLAUSIBLE ? null : Math.round(cop * 100) / 100;
}

/**
 * Momentary coefficient of performance: thermal power divided by electrical power. No value (never an estimate) unless both
 * are present, positive and plausible.
 *
 * @param thermalKw thermal power in kW
 * @param electricalKw electrical power in kW
 */
export function instantCop(thermalKw: number | null, electricalKw: number | null): number | null {
    if (thermalKw === null || electricalKw === null || !Number.isFinite(thermalKw) || !Number.isFinite(electricalKw)) {
        return null;
    }
    if (thermalKw <= 0 || electricalKw < COP_MIN_ELECTRICAL_KW) {
        return null;
    }
    return ratio(thermalKw, electricalKw);
}

/**
 * Ratio of heat to electricity over a period.
 *
 * @param heatKwh heat in kWh
 * @param electricalKwh electricity in kWh
 */
export function periodCop(heatKwh: number, electricalKwh: number): number | null {
    if (electricalKwh < COP_MIN_PERIOD_KWH || heatKwh <= 0) {
        return null;
    }
    return ratio(heatKwh, electricalKwh);
}

/** Which heat meter is authoritative. */
export type ThermalSource = 'navigator' | 'external';

/** The three efficiency figures of one electrical source. */
export interface CopSet {
    /** heat for heating and hot water over all electricity except cooling (the annual performance factor definition) */
    all: number | null;
    /** heating heat over heating and defrost electricity */
    heating: number | null;
    /** hot water heat over hot water electricity */
    dhw: number | null;
}

/**
 * Efficiency figures of a period for one electrical source.
 *
 * - `all`: (heating + hot water heat) / (electricity in heating, hot water, defrost and standby). Cooling is left out on both
 *   sides, defrost heat is reported separately.
 * - `heating`: heating heat / (electricity in heating and defrost).
 * - `dhw`: hot water heat / electricity in hot water mode.
 *
 * With an external heat meter as the authoritative thermal source only `all` can be formed, because that meter does not know
 * the operating mode.
 *
 * @param bucket period sums
 * @param source electrical source
 * @param thermalSource authoritative heat meter
 */
export function copSet(bucket: Bucket, source: ElectricalSource, thermalSource: ThermalSource): CopSet {
    const elec = source === 'internal' ? bucket.elecInternal : bucket.elecExternal;
    const heatingAndHotWater = bucket.thermal.heating + bucket.thermal.dhw;
    const electricalAll = sumModes(elec) - elec.cooling;
    if (thermalSource === 'external') {
        return { all: periodCop(bucket.thermalExternal, electricalAll), heating: null, dhw: null };
    }
    return {
        all: periodCop(heatingAndHotWater, electricalAll),
        heating: periodCop(bucket.thermal.heating, elec.heating + elec.defrost),
        dhw: periodCop(bucket.thermal.dhw, elec.dhw),
    };
}

/**
 * Plausible temperature (the Navigator also reports the "no sensor" value -1.0, which callers filter before).
 *
 * @param value a temperature in °C
 */
function plausible(value: number | null): value is number {
    return value !== null && Number.isFinite(value) && value >= -100 && value <= 200;
}

/**
 * Difference of two temperatures in K.
 *
 * @param first minuend in °C
 * @param second subtrahend in °C
 */
export function temperatureDifference(first: number | null, second: number | null): number | null {
    return plausible(first) && plausible(second) ? Math.round((first - second) * 10) / 10 : null;
}

/**
 * Flow temperature minus its setpoint. A circuit that requests nothing reports a setpoint of 0: that is a normal state, not a
 * deviation, so no value is produced.
 *
 * @param flow measured flow temperature
 * @param setpoint flow setpoint
 */
export function flowDeviation(flow: number | null, setpoint: number | null): number | null {
    return setpoint === 0 ? null : temperatureDifference(flow, setpoint);
}
