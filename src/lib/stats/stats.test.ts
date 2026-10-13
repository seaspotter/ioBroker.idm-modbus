import { expect } from 'chai';
import { CounterTracker } from './counter';
import { copSet, flowDeviation, instantCop, periodCop, temperatureDifference } from './cop';
import { type EngineConfig, StatsEngine, type TickInputs } from './engine';
import { PowerIntegrator } from './integrator';
import { Ledger } from './ledger';
import { CompressorTracker } from './runtime';
import { emptyBucket, modeFromRegister } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** 2026-03-10 12:00 UTC */
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);

describe('PowerIntegrator', () => {
    it('integrates with the trapezoid rule', () => {
        const integrator = new PowerIntegrator(() => 180000);
        expect(integrator.add(T0, 2)).to.equal(null); // first sample
        expect(integrator.add(T0 + 30 * SECOND, 4)).to.be.closeTo(0.025, 1e-9); // 3 kW for 30 s
    });
    it('does not bridge gaps, invalid values or time going backwards', () => {
        const integrator = new PowerIntegrator(() => 180000);
        integrator.add(T0, 2);
        expect(integrator.add(T0 + 5 * MINUTE, 2)).to.equal(null); // gap over 180 s
        expect(integrator.add(T0 + 5 * MINUTE + 30 * SECOND, 2)).to.be.closeTo(0.0167, 1e-3);
        expect(integrator.add(T0 + 6 * MINUTE, null)).to.equal(null); // invalid breaks the chain
        expect(integrator.add(T0 + 6 * MINUTE + 30 * SECOND, 2)).to.equal(null);
        expect(integrator.add(T0 + 6 * MINUTE, 2)).to.equal(null); // time not advancing
        expect(integrator.add(T0 + 7 * MINUTE, -1)).to.equal(null); // negative power is not a measurement
    });
});

describe('CounterTracker', () => {
    it('returns deltas, also across a long pause of the adapter', () => {
        const counter = new CounterTracker(40);
        expect(counter.add(T0, 1000)).to.deep.equal({ discontinuity: 'first' });
        expect(counter.add(T0 + MINUTE, 1000.5)).to.deep.equal({ delta: 0.5 });
        expect(counter.add(T0 + 10 * HOUR, 1020)).to.have.property('delta', 19.5); // 10 h at up to 40 kW would allow 400 kWh
    });
    it('treats resets, impossible jumps, bad values and repeated times as discontinuities', () => {
        const counter = new CounterTracker(40);
        counter.add(T0, 1000);
        expect(counter.add(T0 + MINUTE, 10)).to.deep.equal({ discontinuity: 'reset' }); // meter replaced
        expect(counter.add(T0 + 2 * MINUTE, 500)).to.deep.equal({ discontinuity: 'jump' }); // 490 kWh in a minute
        expect(counter.add(T0 + 3 * MINUTE, null)).to.deep.equal({ discontinuity: 'invalid' });
        expect(counter.add(T0 + 4 * MINUTE, 500.1)).to.have.property('delta'); // baseline was 500, time advanced
        expect(counter.add(T0 + 4 * MINUTE, 500.2)).to.deep.equal({ discontinuity: 'time' });
    });
    it('survives a restart through its memory', () => {
        const first = new CounterTracker(40);
        first.add(T0, 100);
        const second = new CounterTracker(40);
        second.restore(first.memory);
        expect(second.add(T0 + HOUR, 103)).to.deep.equal({ delta: 3 });
        const empty = new CounterTracker(40);
        empty.restore({ at: NaN, value: 1 });
        expect(empty.memory).to.equal(null);
    });
});

describe('Ledger', () => {
    it('sums days, month, year, rolling 365 days and total', () => {
        const ledger = new Ledger();
        ledger.addThermal('2025-03-15', 'heating', 100); // 361 days before 2026-03-11: inside rolling 365, other year
        ledger.addThermal('2025-03-05', 'heating', 50); // 371 days before: outside the rolling window
        ledger.addThermal('2026-01-10', 'heating', 10);
        ledger.addThermal('2026-03-01', 'heating', 5);
        ledger.addThermal('2026-03-10', 'heating', 2);
        ledger.addThermal('2026-03-11', 'dhw', 1);
        const today = '2026-03-11';
        expect(ledger.sum('day', today).thermal).to.deep.include({ heating: 0, dhw: 1 });
        expect(ledger.sum('month', today).thermal.heating).to.equal(7);
        expect(ledger.sum('year', today).thermal.heating).to.equal(17);
        expect(ledger.sum('rolling365', today).thermal.heating).to.equal(117);
        expect(ledger.sum('total', today).thermal.heating).to.equal(167);
    });
    it('keeps at most 400 days but never loses the total', () => {
        const ledger = new Ledger();
        for (let i = 0; i < 450; i++) {
            ledger.addElectrical(utcDate(T0 + i * 24 * HOUR), 'internal', 'heating', 1);
        }
        const data = ledger.serialize();
        expect(data.days).to.have.length(400);
        expect(ledger.sum('total', '2027-06-30').elecInternal.heating).to.equal(450);
    });
    it('round-trips through serialisation and ignores malformed data', () => {
        const ledger = new Ledger();
        ledger.addElectrical('2026-03-10', 'external', 'dhw', 2.5);
        ledger.addCost('2026-03-10', 0.75);
        const restored = new Ledger();
        restored.restore(JSON.parse(JSON.stringify(ledger.serialize())));
        expect(restored.sum('day', '2026-03-10').elecExternal.dhw).to.equal(2.5);
        expect(restored.sum('total', '2026-03-10').cost).to.equal(0.75);
        const broken = new Ledger();
        broken.restore({ days: [{ date: 5 }] as never, totals: 'x' as never });
        expect(broken.sum('total', '2026-03-10')).to.deep.equal(emptyBucket());
    });
});

describe('efficiency figures', () => {
    it('gives no momentary COP at standby, below 50 W, without data, or for artefacts', () => {
        expect(instantCop(6.5, 1.3)).to.equal(5);
        expect(instantCop(0, 0)).to.equal(null); // idle
        expect(instantCop(0.5, 0.03)).to.equal(null); // below 50 W
        expect(instantCop(null, 1)).to.equal(null);
        expect(instantCop(-48, 2)).to.equal(null); // defrost artefact reported by Xerolux
        expect(instantCop(40, 1)).to.equal(null); // ratio over 15
    });
    it('needs at least 0.1 kWh of electricity before a period COP exists', () => {
        expect(periodCop(10, 2)).to.equal(5);
        expect(periodCop(10, 0.05)).to.equal(null);
        expect(periodCop(0, 2)).to.equal(null);
    });
    it('forms the three figures from the buckets as defined in the spec', () => {
        const bucket = emptyBucket();
        bucket.thermal = { heating: 60, dhw: 20, cooling: 7, defrost: 3 };
        bucket.elecInternal = { heating: 12, dhw: 5, cooling: 2, defrost: 1, off: 0.5 };
        bucket.thermalExternal = 80;
        bucket.elecExternal = { heating: 13, dhw: 5, cooling: 2, defrost: 1, off: 1 };
        // all: (60 + 20) / (12 + 5 + 1 + 0.5), cooling left out on both sides
        expect(copSet(bucket, 'internal', 'navigator')).to.deep.equal({ all: 4.32, heating: 4.62, dhw: 4 });
        expect(copSet(bucket, 'external', 'navigator').all).to.equal(4.0); // 80 / 20
        // an external heat meter does not know the mode, so only the overall figure exists
        expect(copSet(bucket, 'external', 'external')).to.deep.equal({ all: 4.0, heating: null, dhw: null });
    });
    it('calculates temperature differences and ignores flow deviation while a circuit requests nothing', () => {
        expect(temperatureDifference(30.59, 27.17)).to.equal(3.4);
        expect(temperatureDifference(null, 27)).to.equal(null);
        expect(temperatureDifference(300, 27)).to.equal(null);
        expect(flowDeviation(26.4, 0)).to.equal(null);
        expect(flowDeviation(26.4, 25)).to.equal(1.4);
    });
});

describe('CompressorTracker', () => {
    it('counts hours, starts and short runs', () => {
        const tracker = new CompressorTracker(() => 180000);
        const day = '2026-03-10';
        /**
         * Samples every 30 s from `fromMin` to `toMin` minutes after T0.
         *
         * @param fromMin first sample, minutes after T0
         * @param toMin last sample, minutes after T0
         * @param running the status to report
         */
        const feedStatus = (fromMin: number, toMin: number, running: boolean): void => {
            for (let t = fromMin * 2; t <= toMin * 2; t++) {
                tracker.add(T0 + t * 30 * SECOND, day, running);
            }
        };
        feedStatus(0, 0.5, false);
        feedStatus(1, 6, true); // start 1, runs 5 minutes (short)
        feedStatus(6.5, 10, false);
        feedStatus(10.5, 40, true); // start 2, runs 29.5 minutes (not short)
        feedStatus(40.5, 41, false);
        const c = tracker.snapshot;
        expect(c).to.include({ startsDay: 2, startsTotal: 2, shortRunsDay: 1 });
        // running samples 1:00-6:30 and 10:30-40:30
        expect(c.hoursDay).to.be.closeTo((5.5 + 30) / 60, 0.01);
    });
    it('does not count hours across gaps or unknown states, and restarts the day counters', () => {
        const tracker = new CompressorTracker(() => 180000);
        tracker.add(T0, '2026-03-10', true);
        tracker.add(T0 + 10 * MINUTE, '2026-03-10', true); // gap: not counted
        expect(tracker.snapshot.hoursDay).to.equal(0);
        tracker.add(T0 + 11 * MINUTE, '2026-03-10', null);
        tracker.add(T0 + 12 * MINUTE, '2026-03-11', false);
        expect(tracker.snapshot).to.include({ hoursDay: 0, startsDay: 0, date: '2026-03-11' });
    });
    it('restores the totals but forgets the run in progress', () => {
        const tracker = new CompressorTracker(() => 180000);
        tracker.add(T0, '2026-03-10', false);
        tracker.add(T0 + 30 * SECOND, '2026-03-10', true);
        const restored = new CompressorTracker(() => 180000);
        restored.restore(JSON.parse(JSON.stringify(tracker.serialize())));
        expect(restored.snapshot).to.include({ startsTotal: 1, running: null });
    });
});

describe('modeFromRegister', () => {
    it('maps register 1090', () => {
        expect([0, 1, 2, 4, 8, null, 3].map(modeFromRegister)).to.deep.equal([
            'off',
            'heating',
            'cooling',
            'dhw',
            'defrost',
            'off',
            'off',
        ]);
    });
});

const baseConfig = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
    externalElectricalCounter: false,
    externalElectricalPower: false,
    externalHeatCounter: false,
    externalHeatPower: false,
    thermalSource: 'navigator',
    pricing: false,
    co2GramsPerKwh: 400,
    circuits: ['A'],
    compressors: 1,
    maxGapMs: () => 180000,
    externalMaxAgeMs: 120000,
    dateKey: utcDate,
    ...overrides,
});

const tick = (now: number, patch: Partial<TickInputs> = {}): TickInputs => ({
    now,
    mode: 1,
    electricalKw: 2,
    thermalKw: 9,
    thermalCounters: { heating: 1000, dhw: 500, cooling: 0, defrost: 0 },
    compressors: [true],
    temperatures: {
        hpFlow: 35,
        hpReturn: 30,
        sourceIn: 8,
        sourceOut: 5,
        dhwTop: 44,
        dhwSetpoint: 46,
        circuits: { A: { flow: 33, setpoint: 32 } },
    },
    ...patch,
});

/**
 * Tick the engine every 30 s for the given minutes, starting at `start`.
 *
 * @param engine the engine
 * @param start start time in ms
 * @param minutes duration
 * @param patch values that differ from the defaults
 */
function feed(engine: StatsEngine, start: number, minutes: number, patch: Partial<TickInputs>): void {
    for (let i = 0; i <= minutes * 2; i++) {
        engine.tick(tick(start + i * 30 * SECOND, patch));
    }
}

describe('StatsEngine', () => {
    it('integrates the internal power, takes thermal energy from the counters and reports the COP', () => {
        const engine = new StatsEngine(baseConfig());
        engine.tick(tick(T0));
        // one hour of heating: 2 kW electrical, heating counter +9 kWh
        for (let i = 1; i <= 120; i++) {
            engine.tick(
                tick(T0 + i * 30 * SECOND, {
                    thermalCounters: { heating: 1000 + (9 * i) / 120, dhw: 500, cooling: 0, defrost: 0 },
                }),
            );
        }
        const out = engine.outputs(T0 + HOUR);
        expect(out['stats.energy.electrical.internal.all.day']).to.be.closeTo(2, 0.001);
        expect(out['stats.energy.electrical.internal.heating.day']).to.be.closeTo(2, 0.001);
        expect(out['stats.energy.thermal.heating.day']).to.be.closeTo(9, 0.001);
        expect(out['stats.cop.internal.all.day']).to.equal(4.5);
        expect(out['stats.energy.thermal.integrated.day']).to.be.closeTo(9, 0.01); // 9 kW of thermal power for one hour, kept for comparison with the counters
        expect(out['stats.cop.internal.heating.total']).to.equal(4.5);
        expect(out['stats.cop.internal.dhw.day']).to.equal(null); // no hot water energy yet
        expect(out['calc.cop_internal']).to.equal(4.5);
        expect(out['calc.hp_delta_t']).to.equal(5);
        expect(out['calc.heat_source_delta_t']).to.equal(3);
        expect(out['calc.dhw_deviation']).to.equal(-2);
        expect(out['calc.hc.A.flow_deviation']).to.equal(1);
        expect(out['stats.co2.day']).to.be.closeTo(0.8, 0.001); // 2 kWh * 400 g
        expect(out).to.not.have.property('stats.cop.external.all.day');
        expect(out).to.not.have.property('stats.cost.day');
    });

    it('attributes energy to the operating mode at the end of the interval', () => {
        const engine = new StatsEngine(baseConfig());
        feed(engine, T0, 30, { mode: 4 }); // 30 minutes of hot water at 2 kW = 1 kWh
        engine.tick(tick(T0 + 30 * MINUTE + 30 * SECOND, { mode: 8 })); // the last 30 s end in defrost
        const out = engine.outputs(T0 + 31 * MINUTE);
        expect(out['stats.energy.electrical.internal.dhw.day']).to.be.closeTo(1, 0.1);
        expect(out['stats.energy.electrical.internal.all.day']).to.be.closeTo(1 + 2 / 120, 0.1); // one decimal
        expect(out['stats.energy.electrical.internal.heating.day']).to.equal(0);
    });

    it('shows no COP while the pump stands still', () => {
        const engine = new StatsEngine(baseConfig());
        engine.tick(tick(T0, { mode: 0, electricalKw: 0, thermalKw: 0, compressors: [false] }));
        engine.tick(tick(T0 + 30 * SECOND, { mode: 0, electricalKw: 0, thermalKw: 0, compressors: [false] }));
        const out = engine.outputs(T0 + MINUTE);
        expect(out['calc.cop_internal']).to.equal(null);
        expect(out['stats.cop.internal.all.day']).to.equal(null);
    });

    it('counts the external meter by its counter, also across a pause of the adapter, and forms a second COP', () => {
        const engine = new StatsEngine(baseConfig({ externalElectricalCounter: true, externalElectricalPower: true }));
        engine.tick(tick(T0));
        engine.onExternalElectricalCounter(T0, 5000);
        engine.onExternalElectricalPower(T0, 2.2);
        engine.tick(tick(T0 + 30 * SECOND, { thermalCounters: { heating: 1000.1, dhw: 500, cooling: 0, defrost: 0 } }));
        // the adapter is stopped for 3 hours; the counters keep counting
        const later = T0 + 3 * HOUR;
        engine.tick(
            tick(later, { thermalCounters: { heating: 1021, dhw: 500, cooling: 0, defrost: 0 }, electricalKw: 2 }),
        );
        engine.onExternalElectricalCounter(later, 5005);
        engine.onExternalElectricalPower(later, 2.5);
        const out = engine.outputs(later + SECOND);
        expect(out['stats.energy.electrical.external.all.day']).to.equal(5);
        expect(out['stats.energy.thermal.heating.day']).to.be.closeTo(21, 0.001);
        expect(out['stats.cop.external.all.day']).to.equal(4.2); // 21 / 5
        expect(out['stats.cop.internal.all.day']).to.equal(null); // internal saw too little energy across the gap to report a figure
        expect(out['calc.cop_external']).to.equal(3.6); // 9 kW / 2.5 kW
    });

    it('integrates an external power state when there is no counter', () => {
        const engine = new StatsEngine(baseConfig({ externalElectricalPower: true }));
        engine.onExternalElectricalPower(T0, 3);
        engine.onExternalElectricalPower(T0 + 60 * SECOND, 3);
        expect(engine.outputs(T0 + 61 * SECOND)['stats.energy.electrical.external.all.day']).to.be.closeTo(0.05, 0.06); // one decimal: 0.1
    });

    it('uses the external heat meter as the authoritative heat source when asked to', () => {
        const engine = new StatsEngine(
            baseConfig({
                externalElectricalCounter: true,
                externalHeatCounter: true,
                externalHeatPower: true,
                thermalSource: 'external',
            }),
        );
        engine.onExternalElectricalCounter(T0, 100);
        engine.onExternalHeatCounter(T0, 500);
        engine.onExternalElectricalCounter(T0 + HOUR, 102);
        engine.onExternalHeatCounter(T0 + HOUR, 509);
        engine.onExternalElectricalPower(T0 + HOUR, 2);
        engine.onExternalHeatPower(T0 + HOUR, 10);
        const out = engine.outputs(T0 + HOUR + SECOND);
        expect(out['stats.cop.external.all.day']).to.equal(4.5);
        expect(out['stats.cop.external.heating.day']).to.equal(null);
        expect(out['stats.energy.thermal.external.day']).to.equal(9);
        expect(out['calc.cop_external']).to.equal(5);
    });

    it('publishes the momentary power of the external meters, only for meters that deliver power', () => {
        const engine = new StatsEngine(baseConfig({ externalElectricalPower: true, externalHeatPower: true }));
        expect(Object.keys(engine.outputs(T0))).to.include.members([
            'calc.power_electrical_external',
            'calc.power_thermal_external',
        ]);
        engine.onExternalElectricalPower(T0, 2.5);
        engine.onExternalHeatPower(T0, 9);
        const out = engine.outputs(T0 + SECOND);
        expect(out['calc.power_electrical_external']).to.equal(2.5);
        expect(out['calc.power_thermal_external']).to.equal(9);
        expect(engine.outputs(T0 + 3 * MINUTE)['calc.power_electrical_external']).to.equal(null); // stale
        const internalOnly = new StatsEngine(baseConfig()).outputs(T0);
        expect(internalOnly).to.not.have.any.keys('calc.power_electrical_external', 'calc.power_thermal_external');
    });

    it('ignores stale external power for the momentary COP', () => {
        const engine = new StatsEngine(baseConfig({ externalElectricalPower: true }));
        engine.tick(tick(T0));
        engine.onExternalElectricalPower(T0, 2);
        expect(engine.outputs(T0 + MINUTE)['calc.cop_external']).to.equal(4.5);
        expect(engine.outputs(T0 + 3 * MINUTE)['calc.cop_external']).to.equal(null);
    });

    it('accrues cost at the price valid at the time and starts a new day', () => {
        const engine = new StatsEngine(baseConfig({ pricing: true }));
        engine.setPrice(0.2);
        feed(engine, T0, 60, {}); // one hour at 2 kW = 2 kWh at 0.20
        expect(engine.outputs(T0 + 61 * MINUTE)['stats.cost.day']).to.be.closeTo(0.4, 0.01);
        engine.setPrice(0.4);
        const nextDay = Date.UTC(2026, 2, 11, 0, 0, 0);
        feed(engine, nextDay, 60, {}); // next day, 2 kWh at 0.40
        const out = engine.outputs(nextDay + 61 * MINUTE);
        expect(out['stats.cost.day']).to.be.closeTo(0.8, 0.01);
        expect(out['stats.cost.total']).to.be.closeTo(1.2, 0.02);
        expect(out['stats.energy.electrical.internal.all.month']).to.be.closeTo(4, 0.01);
        expect(out['stats.energy.electrical.internal.all.day']).to.be.closeTo(2, 0.01);
    });

    it('survives a restart: totals stay and the counter baseline still yields the energy of the pause', () => {
        const first = new StatsEngine(baseConfig());
        first.tick(tick(T0));
        first.tick(tick(T0 + 30 * SECOND, { thermalCounters: { heating: 1000.05, dhw: 500, cooling: 0, defrost: 0 } }));
        const saved = JSON.parse(JSON.stringify(first.serialize()));

        const second = new StatsEngine(baseConfig());
        second.restore(saved);
        second.tick(tick(T0 + 2 * HOUR, { thermalCounters: { heating: 1010.05, dhw: 500, cooling: 0, defrost: 0 } }));
        const out = second.outputs(T0 + 2 * HOUR);
        expect(out['stats.energy.thermal.heating.total']).to.be.closeTo(10.05, 0.06); // 0.05 before the restart, 10 during the pause
        expect(out['stats.runtime.compressor1.starts_total']).to.equal(0);
    });

    it('offers a rolling annual performance factor and per-compressor runtime', () => {
        const engine = new StatsEngine(baseConfig());
        feed(engine, T0, 10, {});
        const out = engine.outputs(T0 + 11 * MINUTE);
        expect(out).to.have.property('stats.cop.internal.all.rolling365');
        expect(out['stats.runtime.compressor1.hours_day']).to.be.closeTo(10 / 60, 0.05); // one decimal
        expect(out).to.not.have.property('stats.runtime.compressor2.hours_day');
    });
});

describe('CO2 accrual', () => {
    it('uses the fixed factor, then the intensity from a state at the time of the energy, and falls back when it is unknown', () => {
        const engine = new StatsEngine(baseConfig({ co2GramsPerKwh: 400 }));
        // the integrator bridges gaps of 3 minutes at most, so an hour is 120 ticks of 30 s
        const stepHours = (hours: number, patch: Partial<TickInputs>, from: number): number => {
            let at = from;
            engine.tick(tick(at, patch));
            for (let i = 0; i < hours * 120; i++) {
                at += 30 * SECOND;
                engine.tick(tick(at, patch));
            }
            return at;
        };
        // 2 kW for one hour = 2 kWh: 0.8 kg at 400 g/kWh
        let at = stepHours(1, { electricalKw: 2 }, T0);
        expect(engine.outputs(at)['stats.co2.day']).to.be.closeTo(0.8, 0.05);
        expect(engine.outputs(at)['stats.co2.intensity']).to.equal(400);
        // the grid is clean for the next hour: 100 g/kWh
        engine.setCo2Intensity(100);
        at = stepHours(1, { electricalKw: 2 }, at + 1);
        expect(engine.outputs(at)['stats.co2.day']).to.be.closeTo(1.0, 0.1); // 0.8 + 0.2
        expect(engine.outputs(at)['stats.co2.intensity']).to.equal(100);
        // the state becomes invalid: the fixed factor again
        engine.setCo2Intensity(null);
        expect(engine.outputs(at)['stats.co2.intensity']).to.equal(400);
        engine.setCo2Intensity(-5); // nonsense is ignored
        expect(engine.outputs(at)['stats.co2.intensity']).to.equal(400);
    });
});

describe('defrost statistics', () => {
    it('counts defrost cycles (operating mode 8) and their duration, and restores them', () => {
        const engine = new StatsEngine(baseConfig());
        const modes = [1, 1, 8, 8, 8, 1, 1, 8, 1];
        modes.forEach((mode, i) => engine.tick(tick(T0 + i * MINUTE, { mode })));
        const out = engine.outputs(T0 + modes.length * MINUTE);
        expect(out['stats.runtime.defrost.starts_total']).to.equal(2);
        expect(out['stats.runtime.defrost.starts_day']).to.equal(2);
        expect(out['stats.runtime.defrost.hours_total']).to.be.closeTo(4 / 60, 0.05); // each sample counts up to the next one: 3 + 1 minutes
        const again = new StatsEngine(baseConfig());
        again.restore(JSON.parse(JSON.stringify(engine.serialize())));
        expect(again.outputs(T0 + modes.length * MINUTE)['stats.runtime.defrost.starts_total']).to.equal(2);
        // data saved before defrost was tracked still restores
        const old = engine.serialize();
        delete old.defrost;
        expect(() => new StatsEngine(baseConfig()).restore(old)).to.not.throw();
    });

    it('does not count an unknown operating mode as defrost', () => {
        const engine = new StatsEngine(baseConfig());
        [null, null, 1].forEach((mode, i) => engine.tick(tick(T0 + i * MINUTE, { mode })));
        expect(engine.outputs(T0 + 3 * MINUTE)['stats.runtime.defrost.starts_total']).to.equal(0);
    });
});

describe('StatsEngine outputs before any data', () => {
    it('lists every key already (null) so that the states can be created at start', () => {
        const engine = new StatsEngine(baseConfig({ externalElectricalPower: true, pricing: true, compressors: 2 }));
        const out = engine.outputs(T0);
        expect(out).to.include({
            'calc.hp_delta_t': null,
            'calc.hc.A.flow_deviation': null,
            'calc.cop_internal': null,
        });
        expect(Object.keys(out)).to.include.members([
            'stats.cost.day',
            'stats.runtime.compressor2.starts_total',
            'stats.cop.external.all.rolling365',
        ]);
    });
});
