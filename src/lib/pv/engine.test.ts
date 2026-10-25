import { expect } from 'chai';
import type { PvSettings, PvSource } from '../config';
import { convertSource, planPvWrites, type PvInput } from './engine';

const NOW = 1_000_000;
const src = (register: PvSource['register'], stateId: string, extra: Partial<PvSource> = {}): PvSource => ({
    register,
    stateId,
    factor: 1,
    invert: false,
    min: null,
    max: null,
    ...extra,
});
const settings = (sources: PvSource[], surplusMode: PvSettings['surplusMode'] = 'direct'): PvSettings => ({
    enabled: true,
    intervalMs: 30000,
    maxAgeMs: 120000,
    surplusMode,
    sources,
    warnings: [],
});
const inputs = (entries: Record<string, unknown>, ageMs = 1000): Map<string, PvInput> =>
    new Map(Object.entries(entries).map(([id, val]) => [id, { val, ts: NOW - ageMs }]));

describe('convertSource', () => {
    it('applies factor, sign and limits, and rounds the battery level to whole percent', () => {
        expect(
            convertSource(src('pv_surplus', 'a', { factor: 0.001 }), { val: 2500, ts: NOW }, NOW, 1000),
        ).to.deep.equal({ value: 2.5 });
        expect(
            convertSource(src('pv_surplus', 'a', { invert: true, min: 0 }), { val: 1.5, ts: NOW }, NOW, 1000),
        ).to.deep.equal({ value: 0 });
        expect(
            convertSource(src('pv_surplus', 'a', { invert: true, min: 0 }), { val: -1.5, ts: NOW }, NOW, 1000),
        ).to.deep.equal({ value: 1.5 });
        expect(convertSource(src('pv_surplus', 'a', { max: 5 }), { val: 9, ts: NOW }, NOW, 1000)).to.deep.equal({
            value: 5,
        });
        expect(convertSource(src('battery_soc', 'a'), { val: 57.4, ts: NOW }, NOW, 1000)).to.deep.equal({ value: 57 });
        expect(convertSource(src('battery_soc', 'a'), { val: 140, ts: NOW }, NOW, 1000)).to.deep.equal({ value: 100 });
    });

    it('reports missing, non-numeric and old values', () => {
        expect(convertSource(src('pv_surplus', 'a'), undefined, NOW, 1000)).to.deep.equal({ missing: 'invalid' });
        expect(convertSource(src('pv_surplus', 'a'), { val: 'abc', ts: NOW }, NOW, 1000)).to.deep.equal({
            missing: 'invalid',
        });
        expect(convertSource(src('pv_surplus', 'a'), { val: null, ts: NOW }, NOW, 1000)).to.deep.equal({
            missing: 'invalid',
        });
        expect(convertSource(src('pv_surplus', 'a'), { val: 1, ts: NOW - 5000 }, NOW, 1000)).to.deep.equal({
            missing: 'stale',
        });
    });
});

describe('planPvWrites', () => {
    it('writes every configured register in direct mode', () => {
        const plan = planPvWrites(
            settings([src('pv_surplus', 's'), src('battery_soc', 'b'), src('pv_production', 'p')]),
            inputs({ s: 1.2, b: 57.4, p: 3.04 }),
            NOW,
        );
        expect(plan.writes.map(w => [w.register, w.value])).to.deep.equal([
            ['pv_surplus', 1.2],
            ['battery_soc', 57],
            ['pv_production', 3.04],
        ]);
    });

    it('keeps writing a register whose source is old or missing: 0, and -1 for the battery level (the Navigator wants every value again)', () => {
        const plan = planPvWrites(
            settings([
                src('pv_surplus', 's'),
                src('pv_production', 'p'),
                src('house_consumption', 'h'),
                src('battery_discharge', 'b'),
                src('battery_soc', 'c'),
            ]),
            inputs({ s: 2, p: 3, h: 1, b: 0.5, c: 80 }, 500000),
            NOW,
        );
        expect(plan.writes.map(w => [w.register, w.value, w.note])).to.deep.equal([
            ['pv_surplus', 0, 'source stale'],
            ['pv_production', 0, 'source stale'],
            ['house_consumption', 0, 'source stale'],
            ['battery_discharge', 0, 'source stale'],
            ['battery_soc', -1, 'source stale'],
        ]);
        expect(plan.skipped.map(s => s.register)).to.have.length(5); // still reported, once, by the runner
        // a source that was never delivered is written as missing, a register without a configured source is not written at all
        const partial = planPvWrites(
            settings([src('pv_surplus', 's'), src('battery_soc', 'c')]),
            inputs({ s: 1 }),
            NOW,
        );
        expect(partial.writes.map(w => [w.register, w.value, w.note])).to.deep.equal([
            ['pv_surplus', 1, undefined],
            ['battery_soc', -1, 'source invalid'],
        ]);
    });

    it('calculates the surplus as production minus house consumption, never below the lower limit', () => {
        const config = settings(
            [src('pv_surplus', 'x', { min: 0 }), src('pv_production', 'p'), src('house_consumption', 'h')],
            'calculated',
        );
        expect(planPvWrites(config, inputs({ p: 3.04, h: 0.49 }), NOW).writes[0]).to.deep.equal({
            register: 'pv_surplus',
            value: 2.55,
            note: 'calculated',
        });
        expect(planPvWrites(config, inputs({ p: 0.2, h: 0.49 }), NOW).writes[0].value).to.equal(0);
        expect(planPvWrites(config, inputs({ p: 3 }), NOW).writes[0]).to.deep.include({
            register: 'pv_surplus',
            value: 0,
        });
    });

    it('does nothing without sources', () => {
        expect(planPvWrites(settings([]), inputs({}), NOW).writes).to.deep.equal([]);
    });
});
