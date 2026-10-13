import type { PlannedObject } from '../object-tree';
import { parentChannelIds } from '../state-model';
import { localized, type LocalizedText } from '../translations';

/** English texts used by the plan; the tests check that every one has all translations. */
export const USED_TEXTS = new Set<string>();

/**
 * Localized text, recorded in {@link USED_TEXTS}.
 *
 * @param key English template
 * @param vars placeholder values
 */
function text(key: string, vars: Record<string, string> = {}): LocalizedText {
    USED_TEXTS.add(key);
    return localized(key, vars);
}

const PERIOD_NAMES: Record<string, string> = {
    day: 'Today',
    month: 'This month',
    year: 'This year',
    total: 'Since start',
    rolling365: 'Last 365 days',
};

const STATE_NAMES: Record<string, string> = {
    hp_delta_t: 'Heat pump flow minus return',
    heat_source_delta_t: 'Heat source inlet minus outlet',
    dhw_deviation: 'Hot water top minus setpoint',
    flow_deviation: 'Flow temperature minus setpoint',
    cop_internal: 'COP now (internal)',
    cop_external: 'COP now (external)',
    power_electrical_external: 'Electrical power (external meter)',
    power_thermal_external: 'Thermal power (external meter)',
    hours_day: 'Operating hours today',
    hours_total: 'Operating hours since start',
    starts_day: 'Starts today',
    starts_total: 'Starts since start',
    short_runs_day: 'Short runs today (under 10 minutes)',
    intensity: 'Current CO₂ intensity of the electricity',
};

const CHANNEL_NAMES: Record<string, string> = {
    calc: 'Calculated values',
    stats: 'Statistics',
    energy: 'Energy',
    thermal: 'Thermal energy',
    electrical: 'Electrical energy',
    cop: 'Efficiency (COP and performance factor)',
    cost: 'Cost',
    co2: 'CO₂ emissions',
    runtime: 'Operating hours and starts',
    internal: 'Internal (Navigator)',
    all: 'All operating modes',
    heating: 'Heating',
    dhw: 'Hot water',
    cooling: 'Cooling',
    defrost: 'Defrost',
    integrated: 'From thermal power register (comparison)',
};

/**
 * Name of a channel from its path.
 *
 * @param path the id split at dots
 */
function channelName(path: string[]): LocalizedText {
    const last = path[path.length - 1];
    const parent = path[path.length - 2];
    if (path[0] === 'calc' && path[1] === 'hc') {
        return path.length === 2 ? text('Heating circuits') : text('Heating circuit {i}', { i: last });
    }
    if (/^compressor\d+$/.test(last)) {
        return text('Compressor {n}', { n: last.replace('compressor', '') });
    }
    if (last === 'external') {
        // an external heat meter below thermal energy, an external electrical meter elsewhere
        return parent === 'thermal' ? text('External heat meter') : text('External meter');
    }
    return text(CHANNEL_NAMES[last] ?? last);
}

/**
 * Role and unit of a state from its id.
 *
 * @param id state id
 * @param currency unit of the cost states
 */
function describe(id: string, currency: string): { role: string; unit?: string } {
    if (id.startsWith('stats.energy.')) {
        return { role: 'value.energy', unit: 'kWh' };
    }
    if (id === 'stats.co2.intensity') {
        return { role: 'value', unit: 'g/kWh' };
    }
    if (id.startsWith('stats.cost.')) {
        return { role: 'value', unit: currency };
    }
    if (id.startsWith('stats.co2.')) {
        return { role: 'value', unit: 'kg' };
    }
    if (/\.hours_(day|total)$/.test(id)) {
        return { role: 'value', unit: 'h' };
    }
    if (/\.power_(electrical|thermal)_external$/.test(id)) {
        return { role: 'value.power', unit: 'kW' };
    }
    if (/delta_t$|deviation$/.test(id)) {
        return { role: 'value', unit: 'K' };
    }
    return { role: 'value' };
}

/**
 * Objects for the statistics outputs: every parent channel first, then the states.
 *
 * @param ids state ids of the outputs (the keys of `StatsEngine.outputs`)
 * @param currency unit of the cost states
 */
export function planStatsObjects(ids: readonly string[], currency: string): PlannedObject[] {
    const channels = new Set<string>();
    for (const id of ids) {
        parentChannelIds(id).forEach(channel => channels.add(channel));
    }
    const channelObjects = [...channels]
        .sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b))
        .map<PlannedObject>(id => ({
            id,
            object: { type: 'channel', common: { name: channelName(id.split('.')) }, native: {} },
        }));
    const stateObjects = ids.map<PlannedObject>(id => {
        const last = id.split('.').pop() as string;
        const key = PERIOD_NAMES[last] ?? STATE_NAMES[last] ?? last;
        const { role, unit } = describe(id, currency);
        return {
            id,
            object: {
                type: 'state',
                common: { name: text(key), type: 'number', role, read: true, write: false, ...(unit ? { unit } : {}) },
                native: {},
            },
        };
    });
    return [...channelObjects, ...stateObjects];
}
