/**
 * Turns a plant scheme of the IDM manuals (`tools/sources/diagram-schemes.json`: the tags drawn in it) into the data the diagram
 * page works on: states with plausible values, objects with names and units, and the diagram settings. Used by the gallery
 * (`tools/build-gallery.ts`) and by the scheme test, so every scheme of the manuals can be drawn and checked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { loadRegisters } from '../src/lib/registers/plant';
import type { RegisterEntry } from '../src/lib/registers/types';
import { stateIdFor } from '../src/lib/state-model';

const root = path.join(__dirname, '..');

/** A scheme of the manuals. */
export interface Scheme {
    id: string;
    unit: string;
    family: 'air' | 'brine';
    manual: string;
    page: number;
    code: string;
    title: string;
    tags: string[];
    storage: 'combined' | 'separate';
    /** Units with more than one compressor (a Twin, a Max). */
    compressors?: number;
    /** Two units in a cascade (master and member). */
    cascade?: boolean;
    /** The number of heating circuits the title names; the other circuits are drawn dashed (optional) in the scheme. */
    circuits?: number;
}

/** What the diagram page gets from the data layer. */
export interface Snapshot {
    states: Record<string, string | number | boolean | null>;
    objects: Record<
        string,
        { type: string; common: { name: unknown; unit?: string; role?: string; states?: Record<string, string> } }
    >;
    settings: { storage?: string };
    language: string;
}

type Plant = { statesOf(tag: string): string[] };
const exported: { module: { exports: unknown } } = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'www', 'plant.js'), 'utf8'), exported);
const plant = exported.module.exports as Plant;

/** The operating modes of the Navigator the pictures are drawn in (`hp.hp_operating_mode`). */
export const MODE = { heating: 1, cooling: 2, hotWater: 4 } as const;

const HOT_WATER_TAGS = ['B41', 'B42', 'B48'];
const COOLING_TAGS = ['B31', 'B40', 'M51', 'M61', 'M62', 'M74'];

/**
 * Does the plant have hot water?
 *
 * @param scheme a scheme of the manuals
 */
export function hasHotWater(scheme: Scheme): boolean {
    return scheme.tags.some(tag => HOT_WATER_TAGS.includes(tag));
}

/**
 * Can the plant cool? The tags that show it are the cold storage, humidity, changeover valves and the reversal valve.
 *
 * @param scheme a scheme of the manuals
 */
export function canCool(scheme: Scheme): boolean {
    return scheme.tags.some(tag => COOLING_TAGS.includes(tag));
}

/** Every scheme of the manuals. */
export function loadSchemes(): Scheme[] {
    const file = path.join(root, 'tools', 'sources', 'diagram-schemes.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { schemes: Scheme[] }).schemes;
}

/** A plausible value of a temperature sensor by tag (degrees Celsius). */
const TEMPERATURES: Record<string, number> = {
    B32: 8,
    B33: 36,
    B34: 30,
    B35: 62,
    B36: 4,
    B37: 6,
    B38: 38,
    B40: 11,
    B41: 38,
    B42: 41,
    B43: 2,
    B44: 12,
    B45: 40,
    B46: 6,
    B48: 48,
    B49: 20,
    B72: 2,
    B73: 55,
    B74: 50,
    B75: 30,
    B76: 18,
    B84: 55,
};
const ANALOG: Record<string, number> = { M13: 5.5, M71: 6, M22: 60, M88: 40 };
// outputs that run in the pictures: the solar pumps and the priority valve of a boiler
const RUNNING = ['M75', 'M76', 'M111'];
const WEB_NAMES: Record<string, string> = {
    B1: 'B1 Hot water flow',
    B2: 'B2 Heating flow sensor',
    B5: 'B5 Dew point monitor heating circuit A',
    B84: 'B84 Tiled stove temperature',
    M75: 'M75 Solar pump 1',
    M76: 'M76 Solar pump 2',
    M88: 'M88 Tiled stove pump',
    M111: 'M111 Boiler priority valve',
    M13: 'M13 Fan speed 1',
    M22: 'M22 Fresh water station',
    M51: 'M51 Four-way valve circuit 1',
    M64: 'M64 Circulation pump',
    M71: 'M71 Hot gas line mixer',
    M73: 'M73 Charging pump',
};

const registerById = new Map<string, RegisterEntry>(
    (loadRegisters('nav20') as RegisterEntry[]).map(reg => [stateIdFor(reg), reg]),
);

/**
 * The data for one scheme.
 *
 * @param scheme a scheme of the manuals
 * @param language language of the page
 * @param mode the operating mode (see `MODE`); cooling also brings the cold water temperatures
 */
export function buildSnapshot(scheme: Scheme, language = 'en', mode: number = MODE.heating): Snapshot {
    const states: Snapshot['states'] = {
        'info.connection': true,
        'system.outdoor_temp': 8,
        'hp.hp_operating_mode': 1,
        'hp.compressor_status_1': 1,
        'energy.power_consumption_hp': 2.1,
        'energy.thermal_power_flow_sensor': 9.4,
        'calc.cop_internal': 4.5,
    };
    const objects: Snapshot['objects'] = {};
    // the heat source side of a unit that the schemes do not draw
    const tags = new Set(scheme.tags);
    // every Navigator has the heat pump flow and return sensors and the charging pump, whatever the scheme draws
    ['B33', 'B34', 'M73'].forEach(tag => tags.add(tag));
    (scheme.family === 'air' ? ['B37', 'M13'] : ['B36', 'B43', 'M16']).forEach(tag => tags.add(tag));
    // the schemes draw a dashed box for optional further circuits; a scheme titled "1 HK" has circuit A only, "2 HK" A and C
    const count = scheme.circuits;
    if (count) {
        const keep = ['A', 'C', 'D', 'E', 'F', 'G'].slice(0, count);
        'ABCDEFG'.split('').forEach((letter, i) => {
            if (!keep.includes(letter) && letter !== 'B') {
                [`B${51 + i}`, `B${61 + i}`, `M${31 + i}`, `M${41 + i}`].forEach(tag => tags.delete(tag));
            }
        });
        if (count === 1 && !/Direktheizkreis|direct/i.test(scheme.title)) {
            ['B52', 'B62', 'M32'].forEach(tag => tags.delete(tag));
        }
    }
    for (let n = 2; n <= (scheme.compressors ?? 1); n++) {
        states[`hp.compressor_status_${n}`] = 1;
    }
    if (scheme.cascade) {
        // two units: stages available and running by mode (the cooling row only where the plant cools)
        const cools = canCool(scheme);
        Object.assign(states, {
            'cascade.cascade_available_heating': 2,
            'cascade.cascade_running_heating': 1,
            'cascade.cascade_available_dhw': hasHotWater(scheme) ? 1 : 0,
            'cascade.cascade_running_dhw': 0,
            ...(cools ? { 'cascade.cascade_available_cooling': 2, 'cascade.cascade_running_cooling': 0 } : {}),
        });
    }
    let index = 0;
    for (const tag of [...tags].sort()) {
        const ids = plant.statesOf(tag);
        const id = ids[0];
        if (!id) {
            continue;
        }
        index++;
        const circuit = /^hc\.([A-G])\.(flow_temp|room_temp)$/.exec(id);
        const reg = registerById.get(id);
        const unit = reg?.unit ?? (id.startsWith('web.io.sensors') ? (tag === 'B2' ? 'l/min' : '°C') : undefined);
        let value: string | number | boolean;
        if (circuit) {
            const i = 'ABCDEFG'.indexOf(circuit[1]);
            value = circuit[2] === 'flow_temp' ? 34 - i : 22;
            states[`hc.${circuit[1]}.active_mode`] = 1;
            states[`hc.${circuit[1]}.setpoint_flow_temp`] = 35 - i;
        } else if (RUNNING.includes(tag)) {
            value = 1;
        } else if (tag in TEMPERATURES) {
            value = TEMPERATURES[tag];
        } else if (tag === 'B31') {
            value = 55;
        } else if (tag in ANALOG) {
            value = ANALOG[tag];
        } else if (/^M4[1-7]$/.test(tag)) {
            value = index % 2 ? 'Auf' : 'Aus';
        } else if (id.startsWith('web.io.digital') || reg?.type === 'BOOL' || reg?.type === 'UCHAR') {
            value = id.startsWith('web.io') ? Number(index % 2) : index % 2 === 0;
        } else {
            value = 20;
        }
        states[id] = value;
        const name = reg ? reg.label : { en: WEB_NAMES[tag] ?? `${tag} ${id}` };
        objects[id] = { type: 'state', common: { name, ...(unit ? { unit } : {}), role: 'value' } };
    }
    states['hp.hp_operating_mode'] = mode;
    if (mode === MODE.cooling) {
        for (const [id, value] of Object.entries(states)) {
            if (typeof value !== 'number') {
                continue;
            }
            if (id === 'hp.hp_flow_temp') {
                states[id] = 12;
            } else if (id === 'hp.hp_return_temp') {
                states[id] = 17;
            } else if (/^hc\.[A-G]\.flow_temp$/.test(id)) {
                states[id] = 16;
            }
        }
    }
    const modeRegister = registerById.get('hp.hp_operating_mode');
    if (modeRegister) {
        objects['hp.hp_operating_mode'] = {
            type: 'state',
            common: {
                name: modeRegister.label,
                role: 'value',
                states: { 0: 'Off', 1: 'Heating', 2: 'Cooling', 4: 'Hot water', 8: 'Defrost' },
            },
        };
    }
    return {
        states,
        objects,
        settings: scheme.storage === 'separate' ? { storage: 'separate' } : {},
        language,
    };
}
