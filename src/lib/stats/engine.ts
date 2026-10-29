import { CounterTracker, type CounterMemory, type CounterStep } from './counter';
import { copSet, flowDeviation, instantCop, temperatureDifference, type ThermalSource } from './cop';
import { PowerIntegrator } from './integrator';
import { Ledger, type LedgerData, type Period } from './ledger';
import { CompressorTracker, type CompressorData } from './runtime';
import {
    type Bucket,
    type ElectricalSource,
    type Mode,
    THERMAL_MODES,
    type ThermalMode,
    modeFromRegister,
    sumModes,
} from './types';

/** Periods with their own states. */
export const PERIODS = ['day', 'month', 'year', 'total'] as const;

/** What the statistics module is set up to do. */
export interface EngineConfig {
    /** an external electrical meter delivers a cumulative counter (kWh) */
    externalElectricalCounter: boolean;
    /** an external electrical meter delivers its power (kW) */
    externalElectricalPower: boolean;
    /** an external heat meter delivers a cumulative counter (kWh) */
    externalHeatCounter: boolean;
    /** an external heat meter delivers its power (kW) */
    externalHeatPower: boolean;
    /** which heat meter counts */
    thermalSource: ThermalSource;
    /** electricity cost is accrued (price per kWh given or provided by a state) */
    pricing: boolean;
    /** CO2 factor in g/kWh */
    co2GramsPerKwh: number;
    /** heating circuit letters whose flow deviation is calculated */
    circuits: string[];
    /** number of compressors to track (0-4) */
    compressors: number;
    /** longest interval between two samples that is still integrated, in ms */
    maxGapMs: () => number;
    /** age after which an external value no longer counts for momentary values, in ms */
    externalMaxAgeMs: number;
    /** local date key `YYYY-MM-DD` of a time */
    dateKey: (ms: number) => string;
}

/** Values the Navigator delivers at a tick. */
export interface TickInputs {
    /** time of the tick in ms */
    now: number;
    /** register 1090 */
    mode: number | null;
    /** register 4122, kW */
    electricalKw: number | null;
    /** register 4126, kW */
    thermalKw: number | null;
    /** heat counters of the Navigator, kWh */
    thermalCounters: Partial<Record<ThermalMode, number | null>>;
    /** compressor running flags (index 0 = compressor 1), `null` = unknown or not present */
    compressors: (boolean | null)[];
    /** temperatures in °C for the momentary differences */
    temperatures: {
        hpFlow: number | null;
        hpReturn: number | null;
        sourceIn: number | null;
        sourceOut: number | null;
        dhwTop: number | null;
        dhwSetpoint: number | null;
        circuits: Record<string, { flow: number | null; setpoint: number | null }>;
    };
}

/** Everything that survives a restart. */
export interface EngineData {
    /** format version */
    version: 1;
    /** energy sums */
    ledger: LedgerData;
    /** counter baselines */
    counters: Record<string, CounterMemory | null>;
    /** compressor counters */
    compressors: CompressorData[];
    /** defrost cycles and duration (absent in data saved by older versions) */
    defrost?: CompressorData;
}

interface Stamped {
    at: number;
    value: number;
}

const round = (value: number, decimals: number): number => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

/**
 * A usable measurement: finite and not negative, else `null`.
 *
 * @param value the reading
 */
const nonNegative = (value: number | null): number | null =>
    value !== null && Number.isFinite(value) && value >= 0 ? value : null;

const stamp = (at: number, value: number | null): Stamped | null => {
    const usable = nonNegative(value);
    return usable === null ? null : { at, value: usable };
};

/** Derived values and statistics of the heat pump (spec Modul G). Pure logic; the adapter feeds it and publishes its outputs. */
export class StatsEngine {
    private readonly ledger = new Ledger();
    private readonly internalIntegrator: PowerIntegrator;
    private readonly externalPowerIntegrator: PowerIntegrator;
    private readonly thermalIntegrator: PowerIntegrator;
    private readonly navigatorCounters: Record<ThermalMode, CounterTracker> = {
        heating: new CounterTracker(60),
        dhw: new CounterTracker(60),
        cooling: new CounterTracker(60),
        defrost: new CounterTracker(60),
    };
    private readonly externalElectricalCounter = new CounterTracker(40);
    private readonly externalHeatCounter = new CounterTracker(80);
    private readonly compressorTrackers: CompressorTracker[];
    private readonly defrostTracker: CompressorTracker;

    private readonly discontinuityLog: string[] = [];
    private mode: Mode = 'off';
    private price: number | null = null;
    private co2Intensity: number | null = null;
    private latest: TickInputs | null = null;
    private externalElectricalPower: Stamped | null = null;
    private externalHeatPower: Stamped | null = null;

    /** @param config module setup */
    public constructor(private readonly config: EngineConfig) {
        this.internalIntegrator = new PowerIntegrator(config.maxGapMs);
        this.externalPowerIntegrator = new PowerIntegrator(config.maxGapMs);
        this.thermalIntegrator = new PowerIntegrator(config.maxGapMs);
        this.defrostTracker = new CompressorTracker(config.maxGapMs);
        this.compressorTrackers = Array.from(
            { length: config.compressors },
            () => new CompressorTracker(config.maxGapMs),
        );
    }

    /** True when an external electrical meter is configured. */
    public get hasExternalElectrical(): boolean {
        return this.config.externalElectricalCounter || this.config.externalElectricalPower;
    }

    /**
     * Counter discontinuities (reset, impossible jump) seen since the last call, as `source:kind`. A first reading, a missing
     * value or a repeated timestamp is not worth reporting.
     */
    public drainDiscontinuities(): string[] {
        return this.discontinuityLog.splice(0);
    }

    private note(source: string, step: CounterStep): void {
        if ('discontinuity' in step && (step.discontinuity === 'reset' || step.discontinuity === 'jump')) {
            this.discontinuityLog.push(`${source}:${step.discontinuity}`);
        }
    }

    /**
     * Set the current electricity price per kWh (fixed or from a state).
     *
     * @param price price, or `null` when unknown
     */
    public setPrice(price: number | null): void {
        this.price = nonNegative(price);
    }

    /**
     * Set the current CO₂ intensity of the electricity in g/kWh (from a state); without a value the fixed factor of the
     * configuration is used.
     *
     * @param gramsPerKwh intensity, or `null` when unknown
     */
    public setCo2Intensity(gramsPerKwh: number | null): void {
        this.co2Intensity = nonNegative(gramsPerKwh);
    }

    /**
     * Process one set of Navigator values.
     *
     * @param inputs the values and the time
     */
    public tick(inputs: TickInputs): void {
        const date = this.config.dateKey(inputs.now);
        this.mode = modeFromRegister(inputs.mode);
        this.latest = inputs;

        const kwh = this.internalIntegrator.add(inputs.now, inputs.electricalKw);
        if (kwh !== null) {
            this.ledger.addElectrical(date, 'internal', this.mode, kwh);
            if (!this.hasExternalElectrical) {
                this.accrueCost(date, kwh);
            }
        }
        const integratedHeat = this.thermalIntegrator.add(inputs.now, inputs.thermalKw);
        if (integratedHeat !== null) {
            this.ledger.addThermalIntegrated(date, integratedHeat);
        }
        for (const mode of THERMAL_MODES) {
            const step = this.navigatorCounters[mode].add(inputs.now, inputs.thermalCounters[mode] ?? null);
            this.note(`navigator-${mode}`, step);
            if ('delta' in step && step.delta > 0) {
                this.ledger.addThermal(date, mode, step.delta);
            }
        }
        this.compressorTrackers.forEach((tracker, index) =>
            tracker.add(inputs.now, date, inputs.compressors[index] ?? null),
        );
        // operating mode 8 is defrost (spec Modul A); a cycle counts as a "start", its duration as "hours"
        this.defrostTracker.add(inputs.now, date, inputs.mode === null ? null : inputs.mode === 8);
    }

    /**
     * An external electrical meter reported its cumulative counter.
     *
     * @param at time of the reading in ms
     * @param kwh counter value in kWh, or `null` when invalid
     */
    public onExternalElectricalCounter(at: number, kwh: number | null): void {
        const step = this.externalElectricalCounter.add(at, kwh);
        this.note('external-electrical', step);
        if ('delta' in step && step.delta > 0) {
            this.addExternalElectrical(at, step.delta);
        }
    }

    /**
     * An external electrical meter reported its power. Without a counter the power is integrated into energy.
     *
     * @param at time of the reading in ms
     * @param kw power in kW, or `null` when invalid
     */
    public onExternalElectricalPower(at: number, kw: number | null): void {
        this.externalElectricalPower = stamp(at, kw);
        if (!this.config.externalElectricalCounter) {
            const kwh = this.externalPowerIntegrator.add(at, kw);
            if (kwh !== null) {
                this.addExternalElectrical(at, kwh);
            }
        }
    }

    /**
     * An external heat meter reported its cumulative counter.
     *
     * @param at time of the reading in ms
     * @param kwh counter value in kWh, or `null` when invalid
     */
    public onExternalHeatCounter(at: number, kwh: number | null): void {
        const step = this.externalHeatCounter.add(at, kwh);
        this.note('external-heat', step);
        if ('delta' in step && step.delta > 0) {
            this.ledger.addThermalExternal(this.config.dateKey(at), step.delta);
        }
    }

    /**
     * An external heat meter reported its power.
     *
     * @param at time of the reading in ms
     * @param kw power in kW, or `null` when invalid
     */
    public onExternalHeatPower(at: number, kw: number | null): void {
        this.externalHeatPower = stamp(at, kw);
    }

    private addExternalElectrical(at: number, kwh: number): void {
        const date = this.config.dateKey(at);
        this.ledger.addElectrical(date, 'external', this.mode, kwh);
        this.accrueCost(date, kwh);
    }

    private accrueCost(date: string, kwh: number): void {
        if (this.config.pricing && this.price !== null) {
            this.ledger.addCost(date, kwh * this.price);
        }
        this.ledger.addCo2(date, (kwh * (this.co2Intensity ?? this.config.co2GramsPerKwh)) / 1000);
    }

    private fresh(stamped: Stamped | null, now: number): number | null {
        return stamped && now - stamped.at <= this.config.externalMaxAgeMs ? stamped.value : null;
    }

    /**
     * All values for the states, keyed by relative state id. `null` = no value (guard rules, missing source).
     *
     * @param now current time in ms
     */
    public outputs(now: number): Record<string, number | null> {
        const out: Record<string, number | null> = {};
        const today = this.config.dateKey(now);
        const t = this.latest?.temperatures;

        // The set of keys must not depend on data (the state plan is built before the first sample arrives).
        out['calc.hp_delta_t'] = t ? temperatureDifference(t.hpFlow, t.hpReturn) : null;
        out['calc.heat_source_delta_t'] = t ? temperatureDifference(t.sourceIn, t.sourceOut) : null;
        out['calc.dhw_deviation'] = t ? temperatureDifference(t.dhwTop, t.dhwSetpoint) : null;
        for (const letter of this.config.circuits) {
            const circuit = t?.circuits[letter];
            out[`calc.hc.${letter}.flow_deviation`] = flowDeviation(circuit?.flow ?? null, circuit?.setpoint ?? null);
        }
        // the external meters' momentary power, for the diagram (kW; null while the meter is silent or stale)
        if (this.config.externalElectricalPower) {
            out['calc.power_electrical_external'] = this.fresh(this.externalElectricalPower, now);
        }
        if (this.config.externalHeatPower) {
            out['calc.power_thermal_external'] = this.fresh(this.externalHeatPower, now);
        }
        const navigatorThermalKw = this.latest?.thermalKw ?? null;
        out['calc.cop_internal'] = instantCop(navigatorThermalKw, this.latest?.electricalKw ?? null);
        if (this.hasExternalElectrical) {
            const thermalKw =
                this.config.thermalSource === 'external' ? this.fresh(this.externalHeatPower, now) : navigatorThermalKw;
            out['calc.cop_external'] = instantCop(thermalKw, this.fresh(this.externalElectricalPower, now));
        }

        const sources: ElectricalSource[] = this.hasExternalElectrical ? ['internal', 'external'] : ['internal'];
        const buckets = {} as Record<Period, Bucket>;
        for (const period of [...PERIODS, 'rolling365'] as Period[]) {
            buckets[period] = this.ledger.sum(period, today);
        }
        for (const period of PERIODS) {
            const bucket = buckets[period];
            for (const mode of THERMAL_MODES) {
                out[`stats.energy.thermal.${mode}.${period}`] = round(bucket.thermal[mode], 1);
            }
            out[`stats.energy.thermal.integrated.${period}`] = round(bucket.thermalIntegrated, 1);
            if (this.config.externalHeatCounter) {
                out[`stats.energy.thermal.external.${period}`] = round(bucket.thermalExternal, 1);
            }
            for (const source of sources) {
                const elec = source === 'internal' ? bucket.elecInternal : bucket.elecExternal;
                out[`stats.energy.electrical.${source}.all.${period}`] = round(sumModes(elec), 1);
                out[`stats.energy.electrical.${source}.heating.${period}`] = round(elec.heating, 1);
                out[`stats.energy.electrical.${source}.dhw.${period}`] = round(elec.dhw, 1);
                const cops = copSet(bucket, source, this.config.thermalSource);
                out[`stats.cop.${source}.all.${period}`] = cops.all;
                out[`stats.cop.${source}.heating.${period}`] = cops.heating;
                out[`stats.cop.${source}.dhw.${period}`] = cops.dhw;
            }
            if (this.config.pricing) {
                out[`stats.cost.${period}`] = round(bucket.cost, 2);
            }
            out[`stats.co2.${period}`] = round(bucket.co2, 1);
        }
        out['stats.co2.intensity'] = round(this.co2Intensity ?? this.config.co2GramsPerKwh, 0);
        for (const source of sources) {
            out[`stats.cop.${source}.all.rolling365`] = copSet(
                buckets.rolling365,
                source,
                this.config.thermalSource,
            ).all;
        }
        this.compressorTrackers.forEach((tracker, index) => {
            const c = tracker.snapshot;
            const prefix = `stats.runtime.compressor${index + 1}`;
            out[`${prefix}.hours_day`] = round(c.hoursDay, 1);
            out[`${prefix}.hours_total`] = round(c.hoursTotal, 1);
            out[`${prefix}.starts_day`] = c.startsDay;
            out[`${prefix}.starts_total`] = c.startsTotal;
            out[`${prefix}.short_runs_day`] = c.shortRunsDay;
        });
        const defrost = this.defrostTracker.snapshot;
        out['stats.runtime.defrost.hours_day'] = round(defrost.hoursDay, 1);
        out['stats.runtime.defrost.hours_total'] = round(defrost.hoursTotal, 1);
        out['stats.runtime.defrost.starts_day'] = defrost.startsDay;
        out['stats.runtime.defrost.starts_total'] = defrost.startsTotal;
        return out;
    }

    /** The state to persist. */
    public serialize(): EngineData {
        return {
            version: 1,
            ledger: this.ledger.serialize(),
            counters: {
                heating: this.navigatorCounters.heating.memory,
                dhw: this.navigatorCounters.dhw.memory,
                cooling: this.navigatorCounters.cooling.memory,
                defrost: this.navigatorCounters.defrost.memory,
                externalElectrical: this.externalElectricalCounter.memory,
                externalHeat: this.externalHeatCounter.memory,
            },
            compressors: this.compressorTrackers.map(tracker => tracker.serialize()),
            defrost: this.defrostTracker.serialize(),
        };
    }

    /**
     * Restore persisted data; unknown or malformed data is ignored (the statistics then start from zero).
     *
     * @param data what {@link serialize} returned earlier
     */
    public restore(data: Partial<EngineData> | null | undefined): void {
        if (!data || data.version !== 1) {
            return;
        }
        this.ledger.restore(data.ledger);
        for (const mode of THERMAL_MODES) {
            this.navigatorCounters[mode].restore(data.counters?.[mode]);
        }
        this.externalElectricalCounter.restore(data.counters?.externalElectrical);
        this.externalHeatCounter.restore(data.counters?.externalHeat);
        this.compressorTrackers.forEach((tracker, index) => tracker.restore(data.compressors?.[index]));
        this.defrostTracker.restore(data.defrost);
    }
}
