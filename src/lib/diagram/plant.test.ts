import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { loadRegisters } from '../registers/plant';
import type { RegisterEntry } from '../registers/types';
import { stateIdFor } from '../state-model';
import { ioKey } from '../web/io';

interface Circuit {
    letter: string;
    flowSensor: boolean;
    pump: boolean;
    mixer: boolean;
    roomDevice: boolean;
    kind: string;
}
interface Plant {
    source: string;
    hotGasLine: boolean;
    compressors: number;
    cooling: Record<string, boolean>;
    storage: Record<string, boolean>;
    circuits: Circuit[];
    additions: Record<string, boolean | number>;
    confirm: string[];
}

// the page script is plain JavaScript for the browser; the tests run the very same file
const script = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', 'plant.js'), 'utf8');
const exported: { module: { exports: unknown } } = { module: { exports: {} } };
vm.runInNewContext(script, exported);
const plant = exported.module.exports as {
    describePlant(has: (id: string) => boolean): Plant;
    statesOf(tag: string): string[];
    TAG_STATES: Record<string, string[]>;
};

/**
 * The plant a scheme of the IDM manuals implies: every tag answers with a value (plus the named extra state ids).
 *
 * @param tags the tags drawn in the scheme
 * @param extra further state ids that carry a value
 */
const describe_ = (tags: string[], extra: string[] = []): Plant => {
    const ids = new Set<string>(extra);
    for (const tag of tags) {
        const states = plant.statesOf(tag);
        expect(states.length, `no state known for ${tag}`).to.be.greaterThan(0);
        ids.add(states[0]);
    }
    return plant.describePlant(id => ids.has(id));
};

describe('plant description (docs/idm-models-and-schemes.md, chapter 6a)', () => {
    it('describes the test device: SLM 3-11 HGL, Hygienik with STP, one mixer circuit, reversal cooling', () => {
        const p = describe_(
            [
                'B37',
                'B35',
                'M71',
                'M13',
                'B33',
                'B34',
                'M73',
                'B41',
                'B48',
                'B42',
                'M22',
                'B1',
                'B38',
                'B51',
                'M31',
                'M41',
                'M64',
                'M51',
                'M61',
                'M62',
                'B5',
            ],
            ['hp.compressor_status_1', ...['1kw', '2kw', '3kw'].map(s => `web.io.digital_out.elektroheizeinsatz_${s}`)],
        );
        expect(p.source).to.equal('air');
        expect(p.hotGasLine).to.equal(true);
        expect(p.compressors).to.equal(1);
        expect(p.cooling).to.include({ reversal: true, buffer: false, isc: false, dewPointMonitor: true, any: true });
        expect(p.storage).to.include({ heatingBuffer: true, hotWater: true, station: true, coolingBuffer: false });
        expect(p.circuits).to.have.length(1);
        expect(p.circuits[0]).to.include({ letter: 'A', mixer: true, pump: true, kind: 'mixer' });
        expect(p.additions).to.include({ circulation: true, rodStages: 3, solar: false, boiler: false, stove: false });
        expect(p.confirm).to.include.members(['product', 'build', 'stpOrTermo']);
    });

    it('recognises a Hygienik for hot water only with a direct circuit (ALM 2-15, L7.1-0-2-0-0): no buffer', () => {
        const p = describe_(['B37', 'B33', 'B34', 'B42', 'B1', 'M22', 'M63', 'M73', 'B61']);
        expect(p.storage).to.include({ heatingBuffer: false, hotWater: false, station: true });
        expect(p.confirm).to.include('directCircuitNoBuffer');
        expect(p.confirm).to.not.include('stpOrTermo');
        expect(p.circuits.map(c => c.letter)).to.deep.equal(['A']);
        expect(p.circuits[0].kind).to.equal('unknown');
    });

    it('recognises an AQA with a heating buffer (L7.1-0-4+5-0-0): hot water and buffer, no station', () => {
        const p = describe_(['B37', 'B38', 'B41', 'B48', 'B51', 'M31', 'M41', 'M63', 'M73']);
        expect(p.storage).to.include({ heatingBuffer: true, hotWater: true, station: false });
    });

    it('recognises solar with pumps (L7.1-7-2+5-0-0)', () => {
        const p = describe_(['B37', 'B73', 'B74', 'B75', 'B77', 'M75', 'M76', 'M78']);
        expect(p.additions).to.include({ solar: true, solarPumps: true });
        expect(describe_(['B37', 'B38']).additions.solar).to.equal(false);
    });

    it('tells cooling through a cooling buffer from reversal cooling (L7.1-0-2+6-2-0)', () => {
        const buffer = describe_(['B37', 'B31', 'B40', 'B38', 'M61', 'M62']);
        expect(buffer.cooling).to.include({ buffer: true, reversal: false, humiditySensor: true, any: true });
        expect(buffer.storage.coolingBuffer).to.equal(true);
        expect(describe_(['B37', 'M51', 'M61']).cooling).to.include({ reversal: true, buffer: false });
        expect(describe_(['B37', 'B38']).cooling.any).to.equal(false);
    });

    it('recognises a brine unit with a hot gas line (SWM, TERRA SW Complete)', () => {
        const p = describe_(['B36', 'B43', 'M16', 'B35', 'M71', 'B41', 'B48', 'B42', 'M22']);
        expect(p.source).to.equal('ground');
        expect(p.hotGasLine).to.equal(true);
    });

    it('recognises a brine tank unit without buffer (iPUMP T direct circuit)', () => {
        const p = describe_(['B36', 'B43', 'M15', 'M16', 'B41', 'B48'], ['hp.compressor_status_1']);
        expect(p.source).to.equal('ground');
        expect(p.hotGasLine).to.equal(false);
        expect(p.confirm).to.include('directCircuitNoBuffer');
    });

    it('counts compressors and recognises the ISC cooling variant (TERRA SW Twin)', () => {
        const p = describe_(
            ['B36', 'B43', 'B44', 'B49', 'M17', 'M84', 'M89', 'M99'],
            ['hp.compressor_status_1', 'hp.compressor_status_2'],
        );
        expect(p.compressors).to.equal(2);
        expect(p.cooling).to.include({ isc: true, any: true, reversal: false });
    });

    it('recognises a stove, a boiler and the waste heat pump (ILM HGL, ALM 10-24)', () => {
        const p = describe_(['B37', 'B35', 'M71', 'B84', 'M88', 'M94', 'M111']);
        expect(p.additions).to.include({ stove: true, boiler: true, wasteHeatPump: true });
        expect(p.hotGasLine).to.equal(true);
    });

    it('finds circuits A to G with mixer and direct circuits (AL 60 Max)', () => {
        const tags = [
            ...[51, 52, 53, 54, 55, 56, 57].map(n => `B${n}`).filter(t => t !== 'B52'),
            ...[61, 62, 63, 64, 65, 66, 67].map(n => `B${n}`),
            ...[31, 32, 33, 34, 35, 36, 37].map(n => `M${n}`),
            ...[41, 43, 44, 45, 46, 47].map(n => `M${n}`),
        ];
        const p = describe_(['B37', ...tags]);
        expect(p.circuits.map(c => c.letter).join('')).to.equal('ABCDEFG');
        expect(p.circuits.find(c => c.letter === 'A')).to.include({ kind: 'mixer', flowSensor: true });
        // circuit B: a pump and no mixer (and no flow sensor B52): a direct circuit
        expect(p.circuits.find(c => c.letter === 'B')).to.include({
            kind: 'direct',
            flowSensor: false,
            roomDevice: true,
        });
        expect(p.circuits.find(c => c.letter === 'G')).to.include({ kind: 'mixer' });
    });

    it('sees a cascade by the cascade registers and nothing in an empty plant', () => {
        expect(plant.describePlant(id => id === 'cascade.cascade_available_heating').additions.cascade).to.equal(true);
        const empty = plant.describePlant(() => false);
        expect(empty).to.deep.include({ source: 'unknown', hotGasLine: false, compressors: 0 });
        expect(empty.circuits).to.have.length(0);
        expect(empty.cooling.any).to.equal(false);
    });

    it('keeps the state ids of the tag table real: Modbus ones are register states, web ones follow the web key rule', () => {
        const known = new Set(
            (['nav20', 'nav10', 'nav17'] as const).flatMap(f => (loadRegisters(f) as RegisterEntry[]).map(stateIdFor)),
        );
        for (const [tag, ids] of Object.entries(plant.TAG_STATES)) {
            for (const id of ids) {
                if (id.startsWith('web.io.')) {
                    const key = id.split('.')[3];
                    if (!/^elektro/.test(key)) {
                        expect(ioKey({ tag: tag, name: '', value: 0, unit: '' }), `${tag} -> ${id}`).to.equal(key);
                    }
                } else {
                    expect(known.has(id), `${tag}: ${id} is not a register state`).to.equal(true);
                }
            }
        }
    });
});
