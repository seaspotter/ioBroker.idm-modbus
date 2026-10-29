import type { PlannedObject } from '../object-tree';
import { localized, type LocalizedText } from '../translations';
import { channelObject } from './objects';

/** The four input/output tables of the Navigator's information menu (`data/settings.php`, ids `INFOAIN` ...). */
export type IoGroup = 'sensors' | 'digital_in' | 'analog_out' | 'digital_out';

/** One row of such a table, e.g. `B2 | Durchflußsensor Heizung | 0.0 | l/min`. */
export interface IoItem {
    /** IDM tag of the measuring point or actor (`B2`, `M22`), empty where the Navigator shows none */
    tag: string;
    /** name as the Navigator shows it (in the language of the device) */
    name: string;
    /** the value; text where the Navigator shows text (`Heizen`, `Aus`) */
    value: number | string;
    /** unit, empty where there is none */
    unit: string;
}

/** Page ids inside `data/settings.php` and the English names of the channels. */
export const IO_GROUPS: Record<IoGroup, { pageId: string; channel: string }> = {
    sensors: { pageId: 'INFOAIN', channel: 'Sensor inputs' },
    digital_in: { pageId: 'INFODIN', channel: 'Digital inputs' },
    analog_out: { pageId: 'INFOAOUT', channel: 'Analog outputs' },
    digital_out: { pageId: 'INFODOUT', channel: 'Digital outputs' },
};

/**
 * English wording of the names the Navigator shows in its own language (German), by lower-case device text, so the states and the
 * diagram read the same as the rest of the adapter. Names that are not listed (other plants have other parts) stay as the device
 * shows them.
 */
const NAMES: Record<string, string> = {
    'durchflußsensor heizung': 'Heating flow sensor',
    'verdampfungsdruck 1': 'Evaporation pressure 1',
    'verdampfungstemp. 1': 'Evaporation temperature 1',
    'kondensationsdruck 1': 'Condensation pressure 1',
    'kondensationstemp. 1': 'Condensation temperature 1',
    'verdampferaustritt 1': 'Evaporator outlet 1',
    'heißgastemperatur 1': 'Hot gas temperature 1',
    'flüssigkeitsleit. temp.': 'Liquid line temperature',
    platinentemperatur: 'Board temperature',
    'batteriespannung zentraleinheit': 'Control unit battery voltage',
    'durchfluss warmwasser': 'Hot water flow',
    'externe anforderung': 'External demand',
    'ext. umschaltung h/k': 'External heating/cooling changeover',
    'ew/evu sperrkontakt': 'Utility lock contact',
    'störung e-heizstab': 'Electric heating rod fault',
    'taupunktwächter heizkreis a': 'Dew point monitor heating circuit A',
    'ext. vorrangladung': 'External priority charging',
    'störung hochdruck 1': 'High pressure fault 1',
    ladepumpe: 'Charging pump',
    'hgl mischer': 'Hot gas line mixer',
    warmwasserstation: 'Fresh water station pump',
    'ventilatordrehzahl 1': 'Fan speed 1',
    '4-wegeventil kreis 1': '4-way valve circuit 1',
    'pumpe heizkreis a': 'Pump heating circuit A',
    'mischer heizkreis a': 'Mixer heating circuit A',
    zirkulationspumpe: 'Circulation pump',
    'siphonheizung 1': 'Siphon heating 1',
    'elektroheizeinsatz 1kw': 'Electric heating element 1 kW',
    'elektroheizeinsatz 2kw': 'Electric heating element 2 kW',
    'elektroheizeinsatz 3kw': 'Electric heating element 3 kW',
    'ventil heizen/kühlen': 'Heating/cooling valve',
    'ventil wärme/kälte': 'Heat/cold valve',
    'ventil heizen/vorrang': 'Heating/priority valve',
};

/**
 * The English name of a row, or `null` for a name the adapter does not know.
 *
 * @param deviceName name as the Navigator shows it
 */
export function englishName(deviceName: string): string | null {
    return NAMES[deviceName.toLowerCase()] ?? null;
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

const clean = (text: string): string =>
    text
        .replace(/&(nbsp|amp|lt|gt|quot);/g, entity => ENTITIES[entity])
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Read the rows of one information table (`<tr><td>tag</td><td>name</td><td>value</td><td>unit</td></tr>`). Rows that do not have
 * four cells and rows without a name are dropped.
 *
 * @param html the table as the Navigator sends it
 */
export function parseInfoTable(html: string): IoItem[] {
    const items: IoItem[] = [];
    for (const row of html.matchAll(/<tr>\s*((?:<td>[^<]*<\/td>\s*){4})<\/tr>/g)) {
        const cells = [...row[1].matchAll(/<td>([^<]*)<\/td>/g)].map(cell => clean(cell[1]));
        const [tag, name, raw, unit] = cells;
        if (!name) {
            continue;
        }
        const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
        items.push({ tag, name, value, unit });
    }
    return items;
}

/**
 * Find the entry with this `id` anywhere in the settings tree.
 *
 * @param node the tree or a part of it
 * @param id page id, e.g. `INFOAIN`
 */
function findPage(node: unknown, id: string): { value?: unknown } | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findPage(child, id);
            if (found) {
                return found;
            }
        }
    } else if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (record.id === id) {
            return record;
        }
        for (const child of Object.values(record)) {
            const found = findPage(child, id);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

/**
 * Take the four input/output tables out of the settings tree. Only these pages are looked at; nothing else of the tree
 * (network information, the myIDM id, ...) is read or kept.
 *
 * @param settings the parsed `data/settings.php`
 */
export function parseIo(settings: unknown): Partial<Record<IoGroup, IoItem[]>> {
    const result: Partial<Record<IoGroup, IoItem[]>> = {};
    for (const group of Object.keys(IO_GROUPS) as IoGroup[]) {
        const page = findPage(settings, IO_GROUPS[group].pageId);
        if (page && typeof page.value === 'string') {
            result[group] = parseInfoTable(page.value);
        }
    }
    return result;
}

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/**
 * State key of a row: the lower-case tag, or a plain-ASCII version of the name where the Navigator shows no tag.
 *
 * @param item the row
 */
export function ioKey(item: IoItem): string {
    if (item.tag) {
        return item.tag.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    }
    return item.name
        .toLowerCase()
        .replace(/[äöüß]/g, char => UMLAUTS[char])
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

const ROLE_BY_UNIT: Record<string, string> = {
    '°C': 'value.temperature',
    bar: 'value.pressure',
    V: 'value.voltage',
};

/** The planned objects and current values of the input/output states. */
export interface IoStates {
    /** channels and states */
    objects: PlannedObject[];
    /** value per state id */
    values: Map<string, number | string | boolean>;
}

/**
 * The value type of a state: digital inputs are booleans, everything else keeps the number or text the Navigator shows (a pump
 * actor reports its percentage, a valve its position).
 *
 * @param group the table
 * @param value the value of the row
 */
function stateType(group: IoGroup, value: number | string): 'boolean' | 'number' | 'string' {
    if (typeof value === 'string') {
        return 'string';
    }
    return group === 'digital_in' ? 'boolean' : 'number';
}

/**
 * The name of a row in all languages where the adapter knows the part, else as the device shows it.
 *
 * @param item the row
 */
function labelOf(item: IoItem): LocalizedText | string {
    const english = englishName(item.name);
    return english ? localized(english) : item.name;
}

/**
 * A label with the IDM tag in front.
 *
 * @param label the label, in one language or in all
 * @param tag IDM tag, may be empty
 */
function withTag(label: LocalizedText | string, tag: string): LocalizedText | string {
    if (!tag) {
        return label;
    }
    if (typeof label === 'string') {
        return `${tag} ${label}`;
    }
    return Object.fromEntries(
        Object.entries(label).map(([language, text]) => [language, `${tag} ${text}`]),
    ) as LocalizedText;
}

/**
 * Turn the tables into states `web.io.<group>.<key>`. The names are the adapter's own where it knows the part, else the device's
 * (like room names).
 *
 * @param io the parsed tables
 * @param isDuplicate tells whether Modbus delivers the part with this IDM tag (those rows are left out)
 */
export function buildIoStates(io: Partial<Record<IoGroup, IoItem[]>>, isDuplicate: (tag: string) => boolean): IoStates {
    const objects: PlannedObject[] = [];
    const values = new Map<string, number | string | boolean>();
    for (const group of Object.keys(IO_GROUPS) as IoGroup[]) {
        const rows = (io[group] ?? []).filter(item => !item.tag || !isDuplicate(item.tag));
        if (!rows.length) {
            continue;
        }
        if (!objects.length) {
            objects.push(channelObject('web.io', 'Inputs and outputs'));
        }
        objects.push(channelObject(`web.io.${group}`, IO_GROUPS[group].channel));
        const used = new Set<string>();
        for (const item of rows) {
            const base = ioKey(item) || 'value';
            let key = base;
            for (let n = 2; used.has(key); n++) {
                key = `${base}_${n}`;
            }
            used.add(key);
            const id = `web.io.${group}.${key}`;
            const type = stateType(group, item.value);
            const role =
                type === 'boolean' ? 'indicator' : type === 'string' ? 'text' : (ROLE_BY_UNIT[item.unit] ?? 'value');
            objects.push({
                id,
                object: {
                    type: 'state',
                    common: {
                        name: withTag(labelOf(item), item.tag),
                        type,
                        role,
                        read: true,
                        write: false,
                        ...(item.unit ? { unit: item.unit } : {}),
                    },
                    native: {},
                },
            });
            values.set(id, type === 'boolean' ? item.value !== 0 : item.value);
        }
    }
    return { objects, values };
}
