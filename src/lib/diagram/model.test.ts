import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { buildDiagramLabels } from '../../../tools/build-diagram-labels';
import { loadRegisters } from '../registers/plant';
import type { RegisterEntry } from '../registers/types';
import { stateIdFor } from '../state-model';
import { DIAGRAM_PARTS } from '../constants';
import { ioKey } from '../web/io';

type Value = string | number | boolean | null;
interface Model {
    language: string;
    heatSource: 'air' | 'ground';
    storage: 'combined' | 'separate';
    parts: Record<string, boolean>;
    ids: Record<string, string | null>;
    circuits: {
        letter: string;
        name: string;
        flow: string | null;
        flowTag: string;
        roomTag: string;
        pump: string | null;
        mixer: string | null;
        pumpTag: string;
        mixerTag: string;
    }[];
    rooms: { zone: number; circuit: string | null; name: string; temperature: string; target: string | null }[];
    sensors: { id: string; tag: string; name: string; unit: string; group: string }[];
    hpModes: Record<string, string>;
    labels: Record<string, string>;
}
interface Settings {
    source?: string;
    cop?: string;
    heatSource?: string;
    storage?: string;
    hidden?: string[];
    zoneCircuit?: { zone: number; circuit: string }[];
}
// the page script runs in the browser and is plain JavaScript; the tests run the very same file
const pageScript = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', 'model.js'), 'utf8');
const exported: { module: { exports: unknown } } = { module: { exports: {} } };
vm.runInNewContext(pageScript, exported);
const diagram = exported.module.exports as {
    buildModel(input: object): Model;
    circuitTags(letter: string): { flow: string; room: string } | null;
    STATE_IDS: Record<string, string[]>;
    PARTS: string[];
};
const labels = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', 'labels.json'), 'utf8'),
) as object;

const build = (
    states: Record<string, Value>,
    extra: { language?: string; settings?: Settings; objects?: Record<string, object> } = {},
): Model => diagram.buildModel({ language: 'en', labels, settings: {}, objects: {}, ...extra, states });

const state = (unit: string, name: string | Record<string, string>): object => ({
    type: 'state',
    common: { unit, name },
});

describe('diagram model', () => {
    it('shows only the parts whose states have values, and only circuits with a flow temperature', () => {
        const model = build({
            'system.outdoor_temp': 8.7,
            'hp.hp_flow_temp': 31,
            'dhw.storage_temp': 36,
            'dhw.dhw_temp_top': 45,
            'hc.A.flow_temp': 27,
            'hc.B.flow_temp': null,
            'pv.pv_production': 3.04,
            'solar.solar_collector_temp': null,
            'zones.1.rooms.1.temp': 23.2,
            'zones.1.rooms.1.setpoint': 22.5,
            'zones.1.rooms.1.name': 'Kid',
            'zones.1.rooms.2.temp': null,
        });
        expect(model.parts).to.deep.equal({
            buffer: true,
            dhw: true,
            freshwater: false,
            pv: true,
            solar: false,
            bivalence: false,
        });
        expect(model.circuits.map(c => c.letter)).to.deep.equal(['A']); // B has no flow temperature
        expect(model.circuits[0].name).to.equal('Heating circuit A');
        expect(model.rooms).to.deep.equal([
            {
                zone: 1,
                circuit: 'A',
                name: 'Kid',
                temperature: 'zones.1.rooms.1.temp',
                target: 'zones.1.rooms.1.setpoint',
            },
        ]);
        expect(model.ids.pvProduction).to.equal('pv.pv_production');
        expect(model.ids.solarCollector).to.equal(null);
    });

    it("has no buffer or hot water part for a direct system, honours hidden parts and uses the user's language and names", () => {
        const model = build(
            { 'hp.hp_flow_temp': 31, 'pv.pv_surplus': 0, 'hc.B.flow_temp': 30, 'dhw.dhw_tapping_temp': 40 },
            {
                language: 'de',
                settings: { hidden: ['pv', 'freshwater'] },
                objects: { 'hc.B': { type: 'channel', common: { name: 'Upstairs' } } },
            },
        );
        expect(model.parts).to.include({ buffer: false, dhw: false, pv: false, freshwater: false });
        expect(model.circuits[0]).to.include({ letter: 'B', name: 'Upstairs', flowTag: 'B52', roomTag: 'B62' });
        expect(model.labels.outdoor).to.equal('Außen');
        expect(model.labels.heatPump).to.equal('Wärmepumpe');
    });

    it('names a circuit by its channel in the user language, else with the default text', () => {
        const model = build(
            { 'hc.A.flow_temp': 30, 'hc.C.flow_temp': 31 },
            {
                language: 'de',
                objects: { 'hc.A': { type: 'channel', common: { name: { en: 'Ground floor', de: 'Erdgeschoss' } } } },
            },
        );
        expect(model.circuits.map(c => c.name)).to.deep.equal(['Erdgeschoss', 'Heizkreis C']);
    });

    it('takes flow and return from the heat sink registers where the heat exchanger hides 1050/1052 (Navigator 10)', () => {
        const model = build({ 'hp.heat_sink_flow_temp': 34, 'hp.heat_sink_return_temp': 29 });
        expect(model.ids.hpFlow).to.equal('hp.heat_sink_flow_temp');
        expect(model.ids.hpReturn).to.equal('hp.heat_sink_return_temp');
    });

    it('prefers the Modbus value of the charging pump and falls back to the web interface', () => {
        expect(build({ 'web.io.analog_out.m73': -1 }).ids.pumpM73).to.equal('web.io.analog_out.m73');
        expect(build({ 'hp.charging_pump_status': 30, 'web.io.analog_out.m73': 30 }).ids.pumpM73).to.equal(
            'hp.charging_pump_status',
        );
    });

    it('names the circuit sensors B51-B57 and B61-B67', () => {
        expect(diagram.circuitTags('A')).to.deep.equal({ flow: 'B51', room: 'B61' });
        expect(diagram.circuitTags('D')).to.deep.equal({ flow: 'B54', room: 'B64' }); // verified live at a Navigator 10 by Xerolux
        expect(diagram.circuitTags('G')).to.deep.equal({ flow: 'B57', room: 'B67' });
        expect(diagram.circuitTags('H')).to.equal(null);
    });

    it('lists the sensors with an IDM tag that are not drawn at a fixed place, sorted by tag', () => {
        const model = build(
            {
                'hp.hp_flow_temp': 31,
                'hp.air_intake_temp': 9.5,
                'hp.heat_source_outlet_temp': 6,
                'web.io.sensors.b2': 12.5,
                'web.io.sensors.b78': 9.4,
                'dhw.cold_storage_temp': 12,
            },
            {
                objects: {
                    'hp.hp_flow_temp': state('°C', 'Heat pump flow temperature (B33)'),
                    'hp.air_intake_temp': state('°C', {
                        en: 'Air intake temperature (B37)',
                        de: 'Ansauglufttemperatur (B37)',
                    }),
                    'hp.heat_source_outlet_temp': state('°C', 'Heat source outlet temperature (B36)'),
                    'web.io.sensors.b2': state('l/min', {
                        en: 'B2 Heating flow sensor',
                        de: 'B2 Durchflußsensor Heizung',
                    }),
                    'web.io.sensors.b78': state('bar', 'B78 Evaporation pressure 1'),
                    'dhw.cold_storage_temp': state('°C', 'Cold storage temperature (B40)'),
                },
                language: 'de',
            },
        );
        // B33 is drawn at a fixed place, the pressure and non-diagram web sensors are not listed
        expect(model.sensors.map(s => `${s.tag}:${s.group}:${s.name}`)).to.deep.equal([
            'B2:heatpump:Durchflußsensor Heizung',
            'B36:source:Heat source outlet temperature',
            'B37:source:Ansauglufttemperatur',
            'B40:storage:Cold storage temperature',
        ]);
    });

    it('tells an air heat pump from a ground one, unless the settings say which', () => {
        const ground = { 'hp.heat_source_inlet_temp': 9.8, 'hp.brine_pump_status': 70 };
        expect(build({ 'hp.hp_flow_temp': 31 }).heatSource).to.equal('air');
        expect(build(ground).heatSource).to.equal('ground');
        expect(build({ ...ground, 'hp.air_intake_temp': 8 }).heatSource).to.equal('air'); // an air intake sensor wins
        expect(build({ 'hp.hp_flow_temp': 31 }, { settings: { heatSource: 'ground' } }).heatSource).to.equal('ground');
        expect(build(ground, { settings: { heatSource: 'air' } }).heatSource).to.equal('air');
        expect(build(ground, { settings: { heatSource: 'auto' } }).heatSource).to.equal('ground');
    });

    it('puts the rooms of zone N next to circuit N unless the settings choose a circuit', () => {
        const states = {
            'hc.A.flow_temp': 30,
            'hc.B.flow_temp': 31,
            'zones.1.rooms.1.temp': 22,
            'zones.2.rooms.1.temp': 22,
            'zones.3.rooms.1.temp': 22,
        };
        expect(build(states).rooms.map(r => r.circuit)).to.deep.equal(['A', 'B', 'B']); // the last circuit takes the rest
        const chosen = build(states, {
            settings: {
                zoneCircuit: [
                    { zone: 1, circuit: 'B' },
                    { zone: 3, circuit: 'A' },
                    { zone: 2, circuit: 'F' },
                ],
            },
        });
        expect(chosen.rooms.map(r => `${r.zone}>${r.circuit}`)).to.deep.equal(['1>B', '2>B', '3>A']);
        expect(build({ 'zones.1.rooms.1.temp': 22 }).rooms[0].circuit).to.equal(null); // no circuit at all
    });

    it('takes the texts of the operating modes from the object', () => {
        const model = build(
            { 'hp.hp_operating_mode': 1 },
            { objects: { 'hp.hp_operating_mode': { type: 'state', common: { states: { 0: 'Off', 1: 'Heating' } } } } },
        );
        expect(model.hpModes).to.deep.equal({ 0: 'Off', 1: 'Heating' });
    });

    it('only asks for states that the register files and the web module create', () => {
        const known = new Set(
            (['nav20', 'nav10', 'nav17'] as const).flatMap(family =>
                (loadRegisters(family) as RegisterEntry[]).map(stateIdFor),
            ),
        );
        for (const id of Object.values(diagram.STATE_IDS).flat()) {
            if (id.startsWith('web.io.')) {
                const key = id.split('.')[3];
                expect(ioKey({ tag: key.toUpperCase(), name: '', value: 0, unit: '' }), id).to.equal(key);
            } else if (!id.startsWith('calc.')) {
                expect(known.has(id), `${id} is not a register state`).to.equal(true);
            }
        }
    });

    it('finds the hot gas mixer M71 of the web interface', () => {
        expect(build({ 'hp.hgl_flow_temp': 48, 'web.io.analog_out.m71': 0 }).ids.hglMixer).to.equal(
            'web.io.analog_out.m71',
        );
        expect(build({ 'hp.hgl_flow_temp': 48 }).ids.hglMixer).to.equal(null);
    });

    it('draws two vessels only when asked and when both hot water and a heating buffer report', () => {
        const states = { 'dhw.dhw_temp_top': 45, 'dhw.storage_temp': 30 };
        expect(build(states).storage).to.equal('combined');
        expect(build(states, { settings: { storage: 'separate' } }).storage).to.equal('separate');
        // without a heating buffer or without hot water there is nothing to separate
        expect(build({ 'dhw.dhw_temp_top': 45 }, { settings: { storage: 'separate' } }).storage).to.equal('combined');
        expect(build({ 'dhw.storage_temp': 30 }, { settings: { storage: 'separate' } }).storage).to.equal('combined');
    });

    it('gives every circuit its own pump and mixer, and lists a direct circuit that has a pump but no flow sensor', () => {
        const model = build({
            'hc.A.flow_temp': 31,
            'web.io.digital_out.m31': 1,
            'web.io.digital_out.m41': 'Aus',
            // circuit B: a direct circuit (pump M32, no mixer, no flow sensor B52)
            'web.io.digital_out.m32': 0,
            'hc.C.flow_temp': 28,
            'web.io.digital_out.m33': 1,
            'web.io.digital_out.m43': 'Auf',
        });
        const byLetter = Object.fromEntries(model.circuits.map(c => [c.letter, c]));
        expect(Object.keys(byLetter)).to.deep.equal(['A', 'B', 'C']);
        expect(byLetter.A).to.include({
            pump: 'web.io.digital_out.m31',
            mixer: 'web.io.digital_out.m41',
            pumpTag: 'M31',
            mixerTag: 'M41',
        });
        expect(byLetter.B).to.include({ pump: 'web.io.digital_out.m32', mixer: null, flow: null, pumpTag: 'M32' });
        expect(byLetter.C).to.include({
            pump: 'web.io.digital_out.m33',
            mixer: 'web.io.digital_out.m43',
            mixerTag: 'M43',
        });
        // a pump alone does not appear without a circuit: nothing is listed where nothing reports
        expect(build({}).circuits).to.have.length(0);
    });

    it('finds the mixer M41 of heating circuit A', () => {
        expect(build({ 'web.io.digital_out.m41': 'Aus' }).ids.mixerM41).to.equal('web.io.digital_out.m41');
        expect(build({}).ids.mixerM41).to.equal(null);
    });

    it('finds the thermal power of the Navigator 2.0 and 1.7', () => {
        expect(build({ 'energy.thermal_power_flow_sensor': 5.9 }).ids.thermalPower).to.equal(
            'energy.thermal_power_flow_sensor',
        );
        expect(build({ 'energy.thermal_power_total': 4.2 }).ids.thermalPower).to.equal('energy.thermal_power_total');
        expect(build({}).ids.thermalPower).to.equal(null);
    });
});

describe('diagram labels', () => {
    it('are up to date in www/labels.json and exist in all 11 languages', () => {
        expect(labels, 'run npm run build:diagram').to.deep.equal(buildDiagramLabels());
        for (const [key, texts] of Object.entries(buildDiagramLabels())) {
            expect(Object.keys(texts), key).to.have.length(11);
            for (const text of Object.values(texts)) {
                expect(text, key).to.be.a('string').and.not.equal('');
            }
        }
    });

    it('knows the same hideable parts as the adapter settings', () => {
        expect(diagram.PARTS).to.deep.equal([...DIAGRAM_PARTS]);
    });

    it('takes the COP from the Navigator or the external meters, shows both or none', () => {
        const states = { 'calc.cop_internal': 6.2, 'calc.cop_external': 4.8 };
        expect(build(states).ids).to.deep.include({ cop: 'calc.cop_internal', cop2: null });
        expect(build(states, { settings: { source: 'external' } }).ids).to.deep.include({
            cop: 'calc.cop_external',
            cop2: null,
        });
        // without an external value the Navigator's is shown
        expect(build({ 'calc.cop_internal': 6.2 }, { settings: { source: 'external' } }).ids.cop).to.equal(
            'calc.cop_internal',
        );
        expect(build(states, { settings: { cop: 'both' } }).ids).to.deep.include({
            cop: 'calc.cop_internal',
            cop2: 'calc.cop_external',
        });
        expect(build(states, { settings: { cop: 'none' } }).ids.cop).to.equal(null);
        expect(build({ 'calc.cop_internal': 6.2 }, { settings: { cop: 'both' } }).ids.cop2).to.equal(null);
    });

    it('takes electrical and thermal power from the Navigator or the external meters, with a fallback', () => {
        const states = {
            'energy.power_consumption_hp': 1.2,
            'energy.thermal_power_flow_sensor': 6,
            'calc.power_electrical_external': 1.1,
        };
        expect(build(states).ids).to.deep.include({
            power: 'energy.power_consumption_hp',
            thermalPower: 'energy.thermal_power_flow_sensor',
        });
        expect(build(states, { settings: { source: 'external' } }).ids).to.deep.include({
            power: 'calc.power_electrical_external',
            thermalPower: 'energy.thermal_power_flow_sensor', // no external heat meter: the Navigator's value
        });
    });
});
