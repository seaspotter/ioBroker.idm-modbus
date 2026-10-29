import type { StatsSettings } from '../config';
import { KEEPALIVE_AFTER_MS, STATS_MIN_GAP_MS, STATS_PERSIST_INTERVAL_MS } from '../constants';
import type { PlannedObject } from '../object-tree';
import type { PollGroup } from '../registers/types';
import { type EngineConfig, StatsEngine, type TickInputs } from './engine';
import { type IntervalTimers, type Logger, type ForeignState, Ticker } from '../runner-kit';
import { planStatsObjects } from './plan';
import type { ThermalMode } from './types';

/** The latest reading of a register, as the poller delivered it. */
export interface Sample {
    /** decoded value, `null` = invalid or not available */
    value: number | null;
    /** time of the reading in ms */
    at: number;
    /** polling group of the register (decides how old a reading may be) */
    poll: PollGroup | null;
}

/** What the runner needs from the adapter; a fake in the tests. */
export interface StatsHost {
    /** clock in ms */
    now(): number;
    /** log lines, never containing host names */
    log: Logger;
    /** managed timers */
    timers: IntervalTimers;
    /** latest reading of a register of the Navigator */
    sample(registerId: string): Sample | undefined;
    /** create channels and states */
    createObjects(objects: PlannedObject[]): Promise<void>;
    /** set a state of the statistics (acknowledged) */
    publish(id: string, value: number | null): void;
    /** read the persisted statistics (JSON) */
    loadData(): Promise<string | null>;
    /** persist the statistics (JSON) */
    saveData(json: string): void;
    /** unit of a foreign state object */
    foreignUnit(id: string): Promise<string | undefined>;
    /** subscribe to a foreign state */
    subscribe(id: string): void;
    /** current value of a foreign state */
    foreignState(id: string): Promise<ForeignState | null>;
}

/** Plant and timing the runner needs. */
export interface RunnerOptions {
    /** statistics settings */
    settings: StatsSettings;
    /** enabled heating circuit letters */
    circuits: string[];
    /** polling intervals per group in ms (decide how old a reading may be) */
    intervalsMs: Record<PollGroup, number>;
    /** how often the statistics are calculated, in ms */
    tickMs: number;
}

const POWER_FACTORS: Record<string, number> = { kW: 1, W: 0.001, MW: 1000 };
const COUNTER_FACTORS: Record<string, number> = { kWh: 1, Wh: 0.001, MWh: 1000 };
/** A state that did not change is written again after this many ticks, so that its timestamp stays current. */
const REFRESH_EVERY_TICKS = 20;

/**
 * Local date key `YYYY-MM-DD` (system time zone).
 *
 * @param ms time in ms
 */
export function localDateKey(ms: number): string {
    const date = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type ExternalKind = 'electricalCounter' | 'electricalPower' | 'heatCounter' | 'heatPower' | 'price' | 'co2';

/** Connects the statistics engine to the adapter: samples in, states out, persistence, external states. */
export class StatsRunner {
    private engine: StatsEngine;
    private readonly ticker: Ticker;
    private readonly persistTicker: Ticker;
    private readonly factors = new Map<ExternalKind, number>();
    private readonly ids = new Map<string, ExternalKind>();
    private readonly published = new Map<string, number | null>();
    private ticks = 0;
    private readonly reported = new Set<string>();

    /**
     * @param host adapter services
     * @param options settings and timing
     */
    public constructor(
        private readonly host: StatsHost,
        private readonly options: RunnerOptions,
    ) {
        this.engine = this.createEngine();
        this.ticker = new Ticker(host.timers);
        this.persistTicker = new Ticker(host.timers);
    }

    private createEngine(): StatsEngine {
        const s = this.options.settings;
        const tickMs = this.options.tickMs;
        const config: EngineConfig = {
            externalElectricalCounter: s.electricalCounter !== null,
            externalElectricalPower: s.electricalPower !== null,
            externalHeatCounter: s.heatCounter !== null,
            externalHeatPower: s.heatPower !== null,
            thermalSource: s.thermalSource,
            pricing: s.pricePerKwh !== null || s.priceStateId !== null,
            co2GramsPerKwh: s.co2GramsPerKwh,
            circuits: this.options.circuits,
            compressors: 4,
            maxGapMs: () => Math.max(STATS_MIN_GAP_MS, 3 * tickMs),
            externalMaxAgeMs: s.externalMaxAgeMs,
            dateKey: localDateKey,
        };
        const engine = new StatsEngine(config);
        if (s.pricePerKwh !== null) {
            engine.setPrice(s.pricePerKwh);
        }
        return engine;
    }

    /** Restore the statistics, create the states, subscribe to the external states and start calculating. */
    public async start(): Promise<void> {
        try {
            const saved = await this.host.loadData();
            if (saved) {
                this.engine.restore(JSON.parse(saved));
            }
        } catch {
            this.host.log.warn('The saved statistics could not be read and are ignored; they start from zero');
        }
        await this.host.createObjects(
            planStatsObjects(Object.keys(this.engine.outputs(this.host.now())), this.options.settings.currency),
        );
        await this.connectExternalSources();
        this.ticker.start(() => this.tick(), this.options.tickMs);
        this.persistTicker.start(() => this.persist(), STATS_PERSIST_INTERVAL_MS);
    }

    /** Stop calculating and save the statistics. */
    public stop(): void {
        this.ticker.stop();
        this.persistTicker.stop();
        this.persist();
    }

    /** Throw away all statistics and start from zero. */
    public reset(): void {
        this.engine = this.createEngine();
        this.published.clear();
        this.persist();
        this.publishAll();
        this.host.log.info('The statistics were reset');
    }

    private async connectExternalSources(): Promise<void> {
        const s = this.options.settings;
        const sources: [ExternalKind, { id: string; unit: string } | null, Record<string, number>][] = [
            ['electricalCounter', s.electricalCounter, COUNTER_FACTORS],
            ['electricalPower', s.electricalPower, POWER_FACTORS],
            ['heatCounter', s.heatCounter, COUNTER_FACTORS],
            ['heatPower', s.heatPower, POWER_FACTORS],
        ];
        for (const [kind, source, table] of sources) {
            if (!source) {
                continue;
            }
            let unit = source.unit;
            if (unit === 'auto') {
                const found = await this.host.foreignUnit(source.id);
                if (!found || table[found] === undefined) {
                    // Guessing would be off by a factor of 1000 in the worst case, silently. Leave the source off instead.
                    this.host.log.warn(
                        `The state of the ${kind} source has no usable unit (${found ?? 'none'}), so this source is switched off. Choose its unit in the configuration (${Object.keys(table).join(' / ')})`,
                    );
                    continue;
                }
                unit = found;
            }
            this.factors.set(kind, table[unit]);
            this.register(kind, source.id);
        }
        if (s.priceStateId) {
            this.register('price', s.priceStateId);
        }
        if (s.co2StateId) {
            this.register('co2', s.co2StateId);
        }
        for (const [id, kind] of this.ids) {
            const state = await this.host.foreignState(id);
            if (state) {
                this.apply(kind, state.val, state.ts);
            }
        }
    }

    private register(kind: ExternalKind, id: string): void {
        this.ids.set(id, kind);
        this.host.subscribe(id);
    }

    /**
     * A subscribed foreign state changed.
     *
     * @param id state id
     * @param state its new state
     */
    public onForeignState(id: string, state: ForeignState | null | undefined): void {
        const kind = this.ids.get(id);
        if (kind && state) {
            this.apply(kind, state.val, state.ts);
        }
    }

    private apply(kind: ExternalKind, raw: unknown, ts: number): void {
        const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        const value = Number.isFinite(number) ? number : null;
        if (kind === 'price') {
            this.engine.setPrice(value === null ? null : value * this.options.settings.priceStateFactor);
            return;
        }
        if (kind === 'co2') {
            this.engine.setCo2Intensity(value === null ? null : value * this.options.settings.co2StateFactor);
            return;
        }
        const scaled = value === null ? null : value * (this.factors.get(kind) ?? 1);
        switch (kind) {
            case 'electricalCounter':
                this.engine.onExternalElectricalCounter(ts, scaled);
                break;
            case 'electricalPower':
                this.engine.onExternalElectricalPower(ts, scaled);
                break;
            case 'heatCounter':
                this.engine.onExternalHeatCounter(ts, scaled);
                break;
            case 'heatPower':
                this.engine.onExternalHeatPower(ts, scaled);
                break;
        }
    }

    /**
     * Latest reading if it is fresh enough: a reading older than 2.5 polling intervals no longer describes the present.
     *
     * @param id register id
     * @param now current time in ms
     */
    private fresh(id: string, now: number): number | null {
        const sample = this.host.sample(id);
        if (!sample || sample.value === null) {
            return null;
        }
        const interval = this.options.intervalsMs[sample.poll ?? 'fast'];
        return now - sample.at <= Math.max(2.5 * interval, KEEPALIVE_AFTER_MS) ? sample.value : null;
    }

    private inputs(now: number): TickInputs {
        const f = (id: string): number | null => this.fresh(id, now);
        const counters: Partial<Record<ThermalMode, number | null>> = {
            heating: f('energy_heating'),
            dhw: f('energy_dhw'),
            cooling: f('energy_cooling'),
            defrost: f('energy_defrost'),
        };
        const circuits: TickInputs['temperatures']['circuits'] = {};
        for (const letter of this.options.circuits) {
            const key = letter.toLowerCase();
            circuits[letter] = { flow: f(`hc_${key}_flow_temp`), setpoint: f(`hc_${key}_setpoint_flow_temp`) };
        }
        return {
            now,
            mode: f('hp_operating_mode'),
            electricalKw: f('power_consumption_hp'),
            thermalKw: f('thermal_power_flow_sensor'),
            thermalCounters: counters,
            compressors: [1, 2, 3, 4].map(n => {
                const value = f(`compressor_status_${n}`);
                return value === null ? null : value !== 0;
            }),
            temperatures: {
                hpFlow: f('hp_flow_temp'),
                hpReturn: f('hp_return_temp'),
                sourceIn: f('heat_source_inlet_temp'),
                sourceOut: f('heat_source_outlet_temp'),
                dhwTop: f('dhw_temp_top'),
                dhwSetpoint: f('dhw_setpoint'),
                circuits,
            },
        };
    }

    private tick(): void {
        const now = this.host.now();
        this.engine.tick(this.inputs(now));
        for (const event of this.engine.drainDiscontinuities()) {
            if (!this.reported.has(event)) {
                this.reported.add(event);
                this.host.log.warn(
                    `Counter discontinuity (${event}): a value went backwards or jumped further than the plant can deliver; that step is skipped. Check the unit setting of the counter`,
                );
            }
        }
        this.ticks++;
        this.publishAll();
    }

    private publishAll(): void {
        const outputs = this.engine.outputs(this.host.now());
        const refresh = this.ticks % REFRESH_EVERY_TICKS === 0;
        for (const [id, value] of Object.entries(outputs)) {
            if (refresh || !this.published.has(id) || this.published.get(id) !== value) {
                this.published.set(id, value);
                this.host.publish(id, value);
            }
        }
    }

    private persist(): void {
        try {
            this.host.saveData(JSON.stringify(this.engine.serialize()));
        } catch (error) {
            this.host.log.warn(`Could not save the statistics: ${(error as Error).message}`);
        }
    }
}
