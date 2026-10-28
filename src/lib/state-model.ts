import type { RegisterEntry } from './registers/types';
import { textIn } from './translations';

/**
 * Relative state id (below the instance namespace) of a register, following the object tree in the spec:
 * `hc.A.flow_temp`, `zones.1.rooms.3.temp`, `zones.1.mode_heat_cool`, `system.system_mode`, `hp.hp_flow_temp`, ...
 *
 * @param reg a register of the register file
 */
export function stateIdFor(reg: RegisterEntry): string {
    if (reg.group === 'hc' && reg.instance) {
        // hc_a_flow_temp -> hc.A.flow_temp
        return `hc.${reg.instance}.${reg.id.replace(/^hc_[a-g]_/, '')}`;
    }
    if (reg.group === 'zones' && reg.instance) {
        // zm1_room3_temp -> zones.1.rooms.3.temp, zm1_mode_heat_cool -> zones.1.mode_heat_cool
        if (reg.room) {
            return `zones.${reg.instance}.rooms.${reg.room}.${reg.id.replace(/^zm\d+_room\d+_/, '')}`;
        }
        return `zones.${reg.instance}.${reg.id.replace(/^zm\d+_/, '')}`;
    }
    if (reg.group === 'glt' && reg.instance) {
        return `glt.${reg.id}`;
    }
    return `${reg.group}.${reg.id}`;
}

/**
 * All parent channel ids of a state id, outermost first (`hc.A.flow_temp` -> `hc`, `hc.A`). Every state needs its
 * parents as objects, no orphans (CLAUDE.md rule 21).
 *
 * @param stateId relative state id
 */
export function parentChannelIds(stateId: string): string[] {
    const parts = stateId.split('.');
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
}

/**
 * Role from the ioBroker role catalogue (CLAUDE.md rule 21: `level.power`/`level.energy` do not exist).
 *
 * @param reg a register
 * @param writable the state may be written by the user (control enabled for its group)
 */
export function roleFor(reg: RegisterEntry, writable = false): string {
    if (writable) {
        if (reg.id === 'error_acknowledge') {
            return 'button';
        }
        if (reg.type === 'BOOL' || (reg.enum === null && reg.min === 0 && reg.max === 1)) {
            return 'switch';
        }
        return reg.unit === '°C' ? 'level.temperature' : 'level';
    }
    switch (reg.unit) {
        case '°C':
            return 'value.temperature';
        case '%rF':
            return 'value.humidity';
        case 'kW':
            return 'value.power';
        case 'kWh':
            return 'value.energy';
        default:
            break;
    }
    if (reg.id === 'battery_soc') {
        return 'value.battery';
    }
    if (reg.type === 'BOOL' || (reg.enum === null && reg.min === 0 && reg.max === 1)) {
        return 'indicator';
    }
    return 'value';
}

/**
 * Object definition for the state of a register. States are read-only in this step; `write` is set by the write module
 * once it exists and its group is enabled (spec "Objektbaum").
 *
 * @param reg a register
 * @param writable the user may write the state (control enabled for its group)
 * @param language ioBroker system language for the texts of enum values (`common.states` takes plain strings only)
 */
export function commonFor(reg: RegisterEntry, writable = false, language = 'en'): ioBroker.StateCommon {
    const role = roleFor(reg, writable);
    const boolean = role === 'indicator' || role === 'switch' || role === 'button';
    const common: ioBroker.StateCommon = {
        name: reg.label,
        type: boolean ? 'boolean' : 'number',
        role,
        read: role !== 'button',
        write: writable,
    };
    if (reg.unit) {
        common.unit = reg.unit;
    }
    if (!boolean && reg.min !== null) {
        common.min = reg.min;
    }
    if (!boolean && reg.max !== null) {
        common.max = reg.max;
    }
    if (reg.enum) {
        // plain strings in the system language: translated objects are not allowed in `common.states`
        common.states = Object.fromEntries(
            Object.entries(reg.enum).map(([value, text]) => [value, textIn(text, language)]),
        );
    }
    return common;
}

/**
 * Value as stored in the state: indicators become booleans, FLOAT values are rounded to three decimals (the 32-bit float
 * noise like 12.128373146057129 is not information), `null` stays `null`.
 *
 * @param reg the register
 * @param value decoded value or `null` for invalid
 */
export function toStateValue(reg: RegisterEntry, value: number | null): number | boolean | null {
    if (value === null) {
        return null;
    }
    if (roleFor(reg) === 'indicator') {
        return value !== 0;
    }
    if (reg.type !== 'FLOAT') {
        return value;
    }
    const factor = 10 ** decimalsFor(reg.unit);
    return Math.round(value * factor) / factor;
}

/**
 * Decimals of a FLOAT state: temperatures, temperature differences and counters (energy, hours) show one decimal - the 32-bit
 * float noise is no information and the sensors are not that exact - everything else three.
 *
 * @param unit unit of the register
 */
function decimalsFor(unit: string | null): number {
    return unit !== null && ['°C', 'K', 'kWh', 'MWh', 'h'].includes(unit) ? 1 : 3;
}
