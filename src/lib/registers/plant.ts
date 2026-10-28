import type { NavigatorFamily } from '../constants';
import nav10 from './nav10.json';
import nav17 from './nav17.json';
import nav20 from './nav20.json';
import type { RegisterEntry } from './types';

/** Heating circuit letters A-G (spec "Register-Modell"). */
export const HEATING_CIRCUITS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/** Which optional parts of the installation exist; comes from the configuration, the scan only suggests (spec section on capability detection). */
export interface PlantConfig {
    /** enabled heating circuit letters */
    heatingCircuits: string[];
    /** number of zone modules (0-10) */
    zoneModules: number;
    /** rooms per zone module (1-8) */
    roomsPerZone: number;
    /** solar, ISC, cascade, bivalence, PV and booster (Navigator 10) register blocks */
    blocks: { solar: boolean; isc: boolean; cascade: boolean; bivalence: boolean; pv: boolean; booster: boolean };
}

/**
 * Register files per family. nav10 and nav17 are documented only, untested on a device (spec Step 10).
 */
const FAMILY_FILES: Partial<Record<NavigatorFamily, { registers: RegisterEntry[] }>> = {
    nav20: nav20 as unknown as { registers: RegisterEntry[] },
    nav10: nav10 as unknown as { registers: RegisterEntry[] },
    nav17: nav17 as unknown as { registers: RegisterEntry[] },
};

/**
 * Load the register list of a family.
 *
 * @param family Navigator generation selected in the configuration
 * @returns the registers, or `null` when that family has no register file yet
 */
export function loadRegisters(family: NavigatorFamily): RegisterEntry[] | null {
    return FAMILY_FILES[family]?.registers ?? null;
}

/**
 * Is a `requires` condition satisfied by the plant configuration?
 *
 * Conditions: `hc:A`, `zone:2`, `room:2.3` (room 3 of zone 2) and `block:solar|isc|cascade|booster`.
 *
 * @param condition one entry of a register's `requires`
 * @param plant the configured installation
 */
function conditionHolds(condition: string, plant: PlantConfig): boolean {
    const [kind, value] = condition.split(':');
    switch (kind) {
        case 'hc':
            return plant.heatingCircuits.includes(value);
        case 'zone':
            return Number(value) >= 1 && Number(value) <= plant.zoneModules;
        case 'room': {
            const [zone, room] = value.split('.').map(Number);
            return zone >= 1 && zone <= plant.zoneModules && room >= 1 && room <= plant.roomsPerZone;
        }
        case 'block':
            return plant.blocks[value as keyof PlantConfig['blocks']] === true;
        default:
            return false;
    }
}

/**
 * Is a register part of the configured installation and readable?
 *
 * Registers of the optional groups `bivalence` and `pv` follow their block switch; everything else follows the
 * register's own `requires`. Write-only registers (access `W`) are never read, so they get no state in this read-only
 * step (writing arrives with module B).
 *
 * @param reg a register
 * @param plant the configured installation
 */
function isActive(reg: RegisterEntry, plant: PlantConfig): boolean {
    if (reg.access === 'W') {
        return false;
    }
    if (reg.group === 'bivalence' && !plant.blocks.bivalence) {
        return false;
    }
    if (reg.group === 'pv' && !plant.blocks.pv) {
        return false;
    }
    if (reg.group === 'booster' && !plant.blocks.booster) {
        return false;
    }
    return reg.requires.every(condition => conditionHolds(condition, plant));
}

/**
 * Registers of a family that the configuration enables.
 *
 * @param registers all registers of the family
 * @param plant the configured installation
 */
export function activeRegisters(registers: readonly RegisterEntry[], plant: PlantConfig): RegisterEntry[] {
    return registers.filter(reg => isActive(reg, plant));
}
