import {
    DEFAULT_CO2_G_PER_KWH,
    DIAGRAM_COP_ROWS,
    DIAGRAM_PARTS,
    MAX_DIAGRAM_ZONE,
    DEFAULT_DAILY_WRITE_WARN,
    DEFAULT_EEPROM_MIN_INTERVAL_S,
    DEFAULT_EXTERNAL_MAX_AGE_S,
    DEFAULT_PRICE_PER_KWH,
    DEFAULT_BOOST_MAX_MINUTES,
    DEFAULT_BOOST_TARGET_C,
    DEFAULT_PV_INTERVAL_S,
    DEFAULT_WEB_INTERVAL_S,
    DEFAULT_NAV10_WEB_PORT,
    DEFAULT_WEB_PORT,
    DEFAULT_WEB_STATISTICS_INTERVAL_S,
    MIN_WEB_INTERVAL_S,
    MIN_WEB_STATISTICS_INTERVAL_S,
    DEFAULT_PV_MAX_AGE_S,
    DEFAULT_ROOM_HEARTBEAT_S,
    DEFAULT_ROOM_MAX_AGE_S,
    DEFAULT_ROOM_MAX_C,
    DEFAULT_ROOM_MIN_C,
    DEFAULT_ROOM_TOLERANCE_C,
    MIN_PV_INTERVAL_S,
    MIN_EEPROM_MIN_INTERVAL_S,
    DEFAULT_FAST_INTERVAL_S,
    DEFAULT_MEDIUM_INTERVAL_S,
    DEFAULT_SLOW_INTERVAL_S,
    CONFIG_INTERVAL_S,
    MIN_CONFIG_INTERVAL_S,
    MIN_FAST_INTERVAL_S,
    NAVIGATOR_FAMILIES,
    type NavigatorFamily,
} from './constants';
import { HEATING_CIRCUITS, type PlantConfig } from './registers/plant';
import type { PollGroup } from './registers/types';
import { clampTimerMs } from './timers';

/** The part of the adapter configuration that describes the installation and the polling. */
export interface PlantSettings {
    /** selected Navigator generation */
    family: NavigatorFamily;
    /** installation layout */
    plant: PlantConfig;
    /** heating circuit names from the configuration, by letter (empty = not named) */
    heatingCircuitNames: Record<string, string>;
    /** polling intervals per group in ms */
    intervalsMs: Record<PollGroup, number>;
    /** problems found; each disabled/corrected entry is reported once, the adapter keeps running (CLAUDE.md rule 18) */
    warnings: string[];
}

/**
 * Read a seconds setting into ms, falling back to the default for NaN/negative values and enforcing a minimum.
 *
 * @param value configured seconds
 * @param fallbackS default in seconds
 * @param minS minimum in seconds
 * @param name setting name for the warning
 * @param warnings collects problems
 */
function intervalMs(value: unknown, fallbackS: number, minS: number, name: string, warnings: string[]): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= minS) {
        return clampTimerMs(value * 1000, fallbackS * 1000);
    }
    if (value !== undefined && value !== null && value !== '') {
        warnings.push(`${name} must be a number of at least ${minS} s, using ${Math.max(fallbackS, minS)} s`);
    }
    return clampTimerMs(Math.max(fallbackS, minS) * 1000, fallbackS * 1000);
}

/**
 * Clamp an integer setting into a range.
 *
 * @param value configured value
 * @param min lower bound
 * @param max upper bound
 * @param fallback value for NaN
 * @param name setting name for the warning
 * @param warnings collects problems
 */
function intSetting(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
    name: string,
    warnings: string[],
): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN;
    if (Number.isNaN(n)) {
        if (value !== undefined && value !== null && value !== '') {
            warnings.push(`${name} is not a number, using ${fallback}`);
        }
        return fallback;
    }
    if (n < min || n > max) {
        warnings.push(`${name} must be between ${min} and ${max}, using ${Math.min(Math.max(n, min), max)}`);
    }
    return Math.min(Math.max(n, min), max);
}

/**
 * Turn the raw adapter configuration into the validated installation layout. A bad entry is corrected or disabled with a
 * warning; this function never throws (CLAUDE.md rule 18).
 *
 * @param config adapter configuration (`this.config`)
 */
export function readPlantSettings(config: Partial<ioBroker.AdapterConfig>): PlantSettings {
    const warnings: string[] = [];
    const flags = config as Record<string, unknown>;

    let family: NavigatorFamily = 'nav20';
    if ((NAVIGATOR_FAMILIES as readonly string[]).includes(config.family as string)) {
        family = config.family as NavigatorFamily;
    } else if (config.family !== undefined) {
        warnings.push(`Unknown Navigator generation "${String(config.family)}", using nav20`);
    }

    const heatingCircuits = HEATING_CIRCUITS.filter(letter => flags[`hc${letter}`] === true) as string[];
    const heatingCircuitNames: Record<string, string> = {};
    for (const letter of HEATING_CIRCUITS) {
        const name = flags[`hcName${letter}`];
        if (typeof name === 'string' && name.trim()) {
            heatingCircuitNames[letter] = name.trim();
        }
    }

    const fastS = intervalMs(
        config.intervalFastS,
        DEFAULT_FAST_INTERVAL_S,
        MIN_FAST_INTERVAL_S,
        'Fast interval',
        warnings,
    );
    const mediumS = intervalMs(
        config.intervalMediumS,
        DEFAULT_MEDIUM_INTERVAL_S,
        MIN_FAST_INTERVAL_S,
        'Medium interval',
        warnings,
    );
    const slowS = intervalMs(
        config.intervalSlowS,
        DEFAULT_SLOW_INTERVAL_S,
        MIN_FAST_INTERVAL_S,
        'Slow interval',
        warnings,
    );
    const configS = intervalMs(
        config.intervalConfigS,
        CONFIG_INTERVAL_S,
        MIN_CONFIG_INTERVAL_S,
        'Settings interval',
        warnings,
    );

    return {
        family,
        plant: {
            heatingCircuits,
            zoneModules: intSetting(config.zoneModules, 0, 10, 0, 'Zone modules', warnings),
            roomsPerZone: intSetting(config.roomsPerZone, 1, 8, 8, 'Rooms per zone module', warnings),
            blocks: {
                solar: config.blockSolar === true,
                isc: config.blockIsc === true,
                cascade: config.blockCascade === true,
                bivalence: config.blockBivalence === true,
                pv: config.blockPv === true,
                booster: config.blockBooster === true,
            },
        },
        heatingCircuitNames,
        intervalsMs: { fast: fastS, medium: mediumS, slow: slowS, config: configS },
        warnings,
    };
}

/** An external value (state id plus the unit the user declared, `auto` = read it from the state's object). */
export interface ExternalSource {
    /** foreign state id */
    id: string;
    /** `auto`, or the unit of the state: kWh/Wh for counters, kW/W for power */
    unit: string;
}

/** Settings of the statistics module (spec Modul G). */
export interface StatsSettings {
    /** module on or off */
    enabled: boolean;
    /** external electrical meter counter / power, or `null` */
    electricalCounter: ExternalSource | null;
    /** external electrical meter power */
    electricalPower: ExternalSource | null;
    /** external heat meter counter */
    heatCounter: ExternalSource | null;
    /** external heat meter power */
    heatPower: ExternalSource | null;
    /** which heat meter counts */
    thermalSource: 'navigator' | 'external';
    /** fixed price per kWh, or `null` when no price is wanted */
    pricePerKwh: number | null;
    /** state delivering the price per kWh, or `null` */
    priceStateId: string | null;
    /** state with the current CO₂ intensity of the electricity in g/kWh, `null` = fixed factor only */
    co2StateId: string | null;
    /** unit shown on the cost states */
    currency: string;
    /** CO2 factor in g/kWh */
    co2GramsPerKwh: number;
    /** factor that turns a value of the price state into the currency per kWh (0.01 when the state is in cents) */
    priceStateFactor: number;
    /** factor that turns a value of the CO2 state into g/kWh (1000 when the state is in kg/kWh) */
    co2StateFactor: number;
    /** age in ms after which an external value counts as stale */
    externalMaxAgeMs: number;
    /** problems found; each source with a problem is switched off, the adapter keeps running */
    warnings: string[];
}

const POWER_UNITS = ['auto', 'kW', 'W'];
const COUNTER_UNITS = ['auto', 'kWh', 'Wh'];

/**
 * Read an external source from the configuration.
 *
 * @param id the configured state id
 * @param unit the configured unit
 * @param allowed units accepted besides `auto`
 * @param name setting name for warnings
 * @param warnings collects problems
 */
function externalSource(
    id: unknown,
    unit: unknown,
    allowed: string[],
    name: string,
    warnings: string[],
): ExternalSource | null {
    if (typeof id !== 'string' || !id.trim()) {
        return null;
    }
    if (!/^[\w.-]+(\.[\w.-]+)+$/.test(id.trim())) {
        warnings.push(`${name}: "${id}" is not a valid state id, this source is switched off`);
        return null;
    }
    const chosen = typeof unit === 'string' && allowed.includes(unit) ? unit : 'auto';
    if (unit !== undefined && unit !== '' && chosen !== unit) {
        warnings.push(`${name}: unknown unit "${typeof unit === 'string' ? unit : typeof unit}", using auto`);
    }
    return { id: id.trim(), unit: chosen };
}

/**
 * Read the statistics settings. Bad entries switch off only the affected source; this never throws (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 */
export function readStatsSettings(config: Partial<ioBroker.AdapterConfig>): StatsSettings {
    const warnings: string[] = [];
    // The units only say how the user types the numbers; everything inside the adapter is currency per kWh and g/kWh.
    const priceFactor = config.priceUnit === 'cent' ? 0.01 : 1;
    const co2Factor = config.co2Unit === 'kg' ? 1000 : 1;
    const price =
        typeof config.pricePerKwh === 'number' && Number.isFinite(config.pricePerKwh) && config.pricePerKwh >= 0
            ? config.pricePerKwh * priceFactor
            : null;
    if (config.pricePerKwh !== undefined && config.pricePerKwh !== null && price === null) {
        warnings.push('Price per kWh must be a number of at least 0, no cost is calculated');
    }
    const co2 =
        typeof config.co2GramsPerKwh === 'number' &&
        Number.isFinite(config.co2GramsPerKwh) &&
        config.co2GramsPerKwh >= 0
            ? config.co2GramsPerKwh * co2Factor
            : DEFAULT_CO2_G_PER_KWH;
    const maxAgeS =
        typeof config.externalMaxAgeS === 'number' &&
        Number.isFinite(config.externalMaxAgeS) &&
        config.externalMaxAgeS >= 10
            ? config.externalMaxAgeS
            : DEFAULT_EXTERNAL_MAX_AGE_S;
    const priceState = externalSource(config.priceStateId, 'auto', ['auto'], 'Price state', warnings);
    const co2State = externalSource(config.co2StateId, 'auto', ['auto'], 'CO2 intensity state', warnings);
    const settings: StatsSettings = {
        enabled: config.statsEnabled !== false,
        electricalCounter: externalSource(
            config.extElecCounterId,
            config.extElecCounterUnit,
            COUNTER_UNITS,
            'External electrical counter',
            warnings,
        ),
        electricalPower: externalSource(
            config.extElecPowerId,
            config.extElecPowerUnit,
            POWER_UNITS,
            'External electrical power',
            warnings,
        ),
        heatCounter: externalSource(
            config.extHeatCounterId,
            config.extHeatCounterUnit,
            COUNTER_UNITS,
            'External heat counter',
            warnings,
        ),
        heatPower: externalSource(
            config.extHeatPowerId,
            config.extHeatPowerUnit,
            POWER_UNITS,
            'External heat power',
            warnings,
        ),
        thermalSource: config.thermalSource === 'external' ? 'external' : 'navigator',
        pricePerKwh: price ?? (config.pricePerKwh === undefined ? DEFAULT_PRICE_PER_KWH : null),
        priceStateId: priceState?.id ?? null,
        co2StateId: co2State?.id ?? null,
        currency:
            typeof config.currency === 'string' && config.currency.trim() ? config.currency.trim().slice(0, 8) : 'EUR',
        co2GramsPerKwh: co2,
        priceStateFactor: priceFactor,
        co2StateFactor: co2Factor,
        externalMaxAgeMs: maxAgeS * 1000,
        warnings,
    };
    if (settings.thermalSource === 'external' && !settings.heatCounter) {
        warnings.push(
            'The external heat meter is chosen as heat source but has no counter state; the Navigator heat counters are used',
        );
        settings.thermalSource = 'navigator';
    }
    return settings;
}

/** Which parts of the installation may be written (spec Modul B). Everything is off unless the user switched it on. */
export interface ControlSettings {
    /** system mode and fault acknowledgement */
    system: boolean;
    /** hot water settings */
    dhw: boolean;
    /** heating circuits whose settings may be written */
    heatingCircuits: string[];
    /** room setpoints and operating modes of the zone modules */
    zones: boolean;
    /** bivalence and cascade settings (expert mode) */
    expert: boolean;
    /** solar operating mode */
    solar: boolean;
    /** minimum time between two writes of one EEPROM register in ms */
    minEepromIntervalMs: number;
    /** warning threshold for writes of one register per day */
    dailyWarnThreshold: number;
    /** problems found */
    warnings: string[];
}

/**
 * Read the control settings. Bad numbers fall back to the defaults with a warning; the intervals can be made longer but
 * never shorter than the protective minimum.
 *
 * @param config adapter configuration
 */
export function readControlSettings(config: Partial<ioBroker.AdapterConfig>): ControlSettings {
    const warnings: string[] = [];
    const flags = config as Record<string, unknown>;
    const interval = config.eepromMinIntervalS;
    let minS = DEFAULT_EEPROM_MIN_INTERVAL_S;
    if (typeof interval === 'number' && Number.isFinite(interval)) {
        minS = Math.max(MIN_EEPROM_MIN_INTERVAL_S, interval);
        if (interval < MIN_EEPROM_MIN_INTERVAL_S) {
            warnings.push(
                `EEPROM minimum interval must be at least ${MIN_EEPROM_MIN_INTERVAL_S} s, using ${MIN_EEPROM_MIN_INTERVAL_S} s`,
            );
        }
    } else if (interval !== undefined && interval !== null) {
        warnings.push(`EEPROM minimum interval is not a number, using ${DEFAULT_EEPROM_MIN_INTERVAL_S} s`);
    }
    const daily = config.dailyWriteWarn;
    const threshold =
        typeof daily === 'number' && Number.isFinite(daily) && daily >= 1
            ? Math.floor(daily)
            : DEFAULT_DAILY_WRITE_WARN;
    if (daily !== undefined && daily !== null && threshold !== Math.floor(Number(daily))) {
        warnings.push(`Daily write warning threshold must be at least 1, using ${DEFAULT_DAILY_WRITE_WARN}`);
    }
    return {
        system: config.writeSystem === true,
        dhw: config.writeDhw === true,
        heatingCircuits: HEATING_CIRCUITS.filter(letter => flags[`writeHc${letter}`] === true),
        zones: config.writeZones === true,
        expert: config.writeExpert === true,
        solar: config.writeSolar === true,
        minEepromIntervalMs: minS * 1000,
        dailyWarnThreshold: threshold,
        warnings,
    };
}

/** Registers of the Navigator that the PV module may write (spec Modul D). */
export const PV_REGISTERS = [
    'pv_surplus',
    'electric_heater_power',
    'pv_production',
    'house_consumption',
    'battery_discharge',
    'battery_soc',
] as const;

/** One PV register and where its value comes from. */
export interface PvSource {
    /** register id */
    register: (typeof PV_REGISTERS)[number];
    /** foreign state with the value */
    stateId: string;
    /** multiplier from the state's unit to the register's unit (kW, %) */
    factor: number;
    /** multiply by -1 after the factor */
    invert: boolean;
    /** lower limit of the written value, `null` = none */
    min: number | null;
    /** upper limit of the written value, `null` = none */
    max: number | null;
}

/** Settings of the PV module. */
export interface PvSettings {
    /** module on */
    enabled: boolean;
    /** write interval in ms */
    intervalMs: number;
    /** a source value older than this counts as missing */
    maxAgeMs: number;
    /** how the surplus (register 74) is obtained */
    surplusMode: 'direct' | 'calculated';
    /** the usable sources, one per register */
    sources: PvSource[];
    /** problems found */
    warnings: string[];
}

const finiteOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Read the PV settings. A row with an unknown register, a duplicate register, no state or a factor of 0 is dropped with a
 * warning; the module never starts with a half-understood row (CLAUDE.md rule 18). There are no default scalings (spec Modul D).
 *
 * @param config adapter configuration
 */
export function readPvSettings(config: Partial<ioBroker.AdapterConfig>): PvSettings {
    const warnings: string[] = [];
    const sources: PvSource[] = [];
    const seen = new Set<string>();
    const rows = Array.isArray(config.pvSources) ? config.pvSources : [];
    for (const row of rows) {
        const register = PV_REGISTERS.find(id => id === row?.register);
        const stateId = typeof row?.stateId === 'string' ? row.stateId.trim() : '';
        if (!register || !stateId) {
            warnings.push(`PV row ignored: register or state missing (${String(row?.register)})`);
            continue;
        }
        if (seen.has(register)) {
            warnings.push(`PV row for ${register} ignored: the register is configured twice`);
            continue;
        }
        const factor = typeof row.factor === 'number' && Number.isFinite(row.factor) ? row.factor : NaN;
        if (!factor) {
            warnings.push(`PV row for ${register} ignored: the factor is missing or 0`);
            continue;
        }
        seen.add(register);
        sources.push({
            register,
            stateId,
            factor,
            invert: row.invert === true,
            min: finiteOrNull(row.min),
            max: finiteOrNull(row.max),
        });
    }
    const surplusMode = config.pvSurplusMode === 'calculated' ? 'calculated' : 'direct';
    return {
        enabled: config.pvEnabled === true,
        intervalMs:
            intSetting(config.pvIntervalS, MIN_PV_INTERVAL_S, 3600, DEFAULT_PV_INTERVAL_S, 'PV interval', warnings) *
            1000,
        maxAgeMs: intSetting(config.pvMaxAgeS, 10, 86400, DEFAULT_PV_MAX_AGE_S, 'PV maximum age', warnings) * 1000,
        surplusMode,
        sources,
        warnings,
    };
}

/** One heating circuit whose room temperature comes from a foreign state (spec Modul C, target 1). */
export interface RoomSource {
    /** heating circuit letter (empty for the other GLT values) */
    circuit: string;
    /** register id that receives the value */
    registerId: string;
    /** foreign state with the temperature */
    stateId: string;
    /** multiplier to °C */
    factor: number;
    /** added after the factor */
    offset: number;
    /** write at least this often, also without a change */
    heartbeatMs: number;
    /** a change of at least this many °C is written at once */
    toleranceC: number;
    /** values below are not written */
    min: number;
    /** values above are not written */
    max: number;
    /** older source values count as missing */
    maxAgeMs: number;
    /** `stop`: write nothing; `fixed`: write `fixedValue` */
    onStale: 'stop' | 'fixed';
    /** value written for `fixed`, `null` = none */
    fixedValue: number | null;
}

/** Settings of the room temperature feeding. */
export interface RoomSettings {
    /** module on */
    enabled: boolean;
    /** the usable rows, one per heating circuit */
    sources: RoomSource[];
    /** problems found */
    warnings: string[];
}

/**
 * Read the room feeding settings; unusable rows are dropped with a warning (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 */
export function readRoomSettings(config: Partial<ioBroker.AdapterConfig>): RoomSettings {
    const warnings: string[] = [];
    const sources: RoomSource[] = [];
    const seen = new Set<string>();
    const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    for (const row of Array.isArray(config.roomSources) ? config.roomSources : []) {
        const circuit = HEATING_CIRCUITS.find(letter => letter === row?.circuit);
        const stateId = typeof row?.stateId === 'string' ? row.stateId.trim() : '';
        if (!circuit || !stateId) {
            warnings.push(`Room row ignored: heating circuit or state missing (${String(row?.circuit)})`);
            continue;
        }
        if (seen.has(circuit)) {
            warnings.push(`Room row for heating circuit ${circuit} ignored: configured twice`);
            continue;
        }
        const factor = num(row.factor, 1);
        const min = num(row.min, DEFAULT_ROOM_MIN_C);
        const max = num(row.max, DEFAULT_ROOM_MAX_C);
        if (!factor || min >= max) {
            warnings.push(`Room row for heating circuit ${circuit} ignored: factor is 0 or the range is empty`);
            continue;
        }
        seen.add(circuit);
        sources.push({
            circuit,
            registerId: `hc_${circuit.toLowerCase()}_ext_room_temp`,
            stateId,
            factor,
            offset: num(row.offset, 0),
            heartbeatMs: Math.max(30, num(row.heartbeatS, DEFAULT_ROOM_HEARTBEAT_S)) * 1000,
            toleranceC: Math.max(0.1, num(row.toleranceC, DEFAULT_ROOM_TOLERANCE_C)),
            min,
            max,
            maxAgeMs: Math.max(60, num(row.maxAgeS, DEFAULT_ROOM_MAX_AGE_S)) * 1000,
            onStale: row.onStale === 'fixed' && typeof row.fixedValue === 'number' ? 'fixed' : 'stop',
            fixedValue: typeof row.fixedValue === 'number' && Number.isFinite(row.fixedValue) ? row.fixedValue : null,
        });
    }
    if (config.roomsEnabled === true && !sources.length) {
        warnings.push('Room temperature feeding is on, but no usable row is configured');
    }
    return { enabled: config.roomsEnabled === true, sources, warnings };
}

/** GLT values of the Navigator that are written cyclically (spec Modul E) with the defaults of the spec. */
export const GLT_FUNCTIONS = {
    outdoor_temp: { register: 'ext_outdoor_temp', heartbeatS: 60, min: -50, max: 60, tolerance: 0.2 },
    humidity: { register: 'ext_humidity', heartbeatS: 60, min: 0, max: 100, tolerance: 1 },
    temp_demand_heating: { register: 'glt_temp_demand_heating', heartbeatS: 600, min: 10, max: 90, tolerance: 0.5 },
    temp_demand_cooling: { register: 'glt_temp_demand_cooling', heartbeatS: 600, min: 5, max: 30, tolerance: 0.5 },
    demand_heating: { register: 'demand_heating', heartbeatS: 60, min: 0, max: 1, tolerance: 0.5 },
    demand_cooling: { register: 'demand_cooling', heartbeatS: 60, min: 0, max: 1, tolerance: 0.5 },
    demand_dhw: { register: 'demand_dhw_charging', heartbeatS: 60, min: 0, max: 1, tolerance: 0.5 },
    heat_storage_temp: { register: 'glt_heat_storage_temp', heartbeatS: 60, min: 0, max: 100, tolerance: 0.2 },
    cold_storage_temp: { register: 'glt_cold_storage_temp', heartbeatS: 60, min: 0, max: 100, tolerance: 0.2 },
    dhw_temp_bottom: { register: 'glt_dhw_temp_bottom', heartbeatS: 60, min: 0, max: 100, tolerance: 0.2 },
    dhw_temp_top: { register: 'glt_dhw_temp_top', heartbeatS: 60, min: 0, max: 100, tolerance: 0.2 },
} as const;

/** Settings of the GLT value feeding. */
export interface GltSettings {
    /** module on */
    enabled: boolean;
    /** the usable rows, one per function (same shape as the room rows) */
    sources: RoomSource[];
    /** problems found */
    warnings: string[];
}

/**
 * Read the GLT feeding settings. Missing numbers take the defaults of the function; a row without function or state, or a
 * function configured twice, is dropped with a warning (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 */
export function readGltSettings(config: Partial<ioBroker.AdapterConfig>): GltSettings {
    const warnings: string[] = [];
    const sources: RoomSource[] = [];
    const seen = new Set<string>();
    const num = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    for (const row of Array.isArray(config.gltSources) ? config.gltSources : []) {
        const name = String(row?.function) as keyof typeof GLT_FUNCTIONS;
        const def = GLT_FUNCTIONS[name];
        const stateId = typeof row?.stateId === 'string' ? row.stateId.trim() : '';
        if (!def || !stateId) {
            warnings.push(`GLT row ignored: function or state missing (${String(row?.function)})`);
            continue;
        }
        if (seen.has(name)) {
            warnings.push(`GLT row for ${name} ignored: configured twice`);
            continue;
        }
        const factor = num(row.factor, 1);
        const min = num(row.min, def.min);
        const max = num(row.max, def.max);
        if (!factor || min >= max) {
            warnings.push(`GLT row for ${name} ignored: factor is 0 or the range is empty`);
            continue;
        }
        seen.add(name);
        sources.push({
            circuit: '',
            registerId: def.register,
            stateId,
            factor,
            offset: num(row.offset, 0),
            heartbeatMs: Math.max(30, num(row.heartbeatS, def.heartbeatS)) * 1000,
            toleranceC: def.tolerance,
            min,
            max,
            maxAgeMs: Math.max(60, num(row.maxAgeS, DEFAULT_ROOM_MAX_AGE_S)) * 1000,
            onStale: 'stop',
            fixedValue: null,
        });
    }
    if (config.gltEnabled === true && !sources.length) {
        warnings.push('GLT value feeding is on, but no usable row is configured');
    }
    return { enabled: config.gltEnabled === true, sources, warnings };
}

/** Settings of the web interface module. */
export interface WebSettings {
    /** module on */
    enabled: boolean;
    /** the display PIN */
    pin: string;
    /** HTTP port */
    port: number;
    /** poll interval in ms */
    intervalMs: number;
    /** poll interval of the statistics pages in ms, 0 = not read */
    statisticsIntervalMs: number;
    /** problems found */
    warnings: string[];
}

/**
 * Read the web module settings; without a PIN the module stays off with a warning (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 * @param family the Navigator generation (decides the default port)
 */
export function readWebSettings(config: Partial<ioBroker.AdapterConfig>, family: NavigatorFamily): WebSettings {
    const warnings: string[] = [];
    const pin = typeof config.webPin === 'string' ? config.webPin.trim() : '';
    const enabled = config.webEnabled === true;
    const statisticsSeconds =
        config.webStatisticsIntervalS === 0 ? 0 : (config.webStatisticsIntervalS ?? DEFAULT_WEB_STATISTICS_INTERVAL_S);
    if (enabled && !pin) {
        warnings.push('The web interface module is on, but no PIN is configured - it stays off');
    }
    return {
        enabled: enabled && pin !== '',
        pin,
        // 0 = automatic: the PHP pages of the Navigator 2.0 on port 80, the WebSocket of the Navigator 10 on 61220
        port: intSetting(
            config.webPort || (family === 'nav10' ? DEFAULT_NAV10_WEB_PORT : DEFAULT_WEB_PORT),
            1,
            65535,
            DEFAULT_WEB_PORT,
            'Web interface port',
            warnings,
        ),
        intervalMs:
            intSetting(
                config.webIntervalS,
                MIN_WEB_INTERVAL_S,
                86400,
                DEFAULT_WEB_INTERVAL_S,
                'Web interface interval',
                warnings,
            ) * 1000,
        statisticsIntervalMs:
            statisticsSeconds === 0
                ? 0
                : intSetting(
                      statisticsSeconds,
                      MIN_WEB_STATISTICS_INTERVAL_S,
                      604800,
                      DEFAULT_WEB_STATISTICS_INTERVAL_S,
                      'Web statistics interval',
                      warnings,
                  ) * 1000,
        warnings,
    };
}

/** Settings of the hot water boost. */
export interface BoostSettings {
    /** boost switched on */
    enabled: boolean;
    /** the boost ends at this hot water temperature in °C */
    targetC: number;
    /** the boost ends after this many minutes */
    maxMinutes: number;
    /** problems found */
    warnings: string[];
}

/**
 * Read the boost settings. Values outside the hard limits are corrected with a warning (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 */
export function readBoostSettings(config: Partial<ioBroker.AdapterConfig>): BoostSettings {
    const warnings: string[] = [];
    return {
        enabled: config.boostEnabled === true,
        targetC: intSetting(config.boostTargetC, 40, 65, DEFAULT_BOOST_TARGET_C, 'Boost target temperature', warnings),
        maxMinutes: intSetting(
            config.boostMaxMinutes,
            5,
            240,
            DEFAULT_BOOST_MAX_MINUTES,
            'Boost maximum duration',
            warnings,
        ),
        warnings,
    };
}

/** What the heat pump diagram page reads from the state `diagram.settings`. */
export interface DiagramSettings {
    /** 'air' or 'ground'; left out for automatic detection */
    heatSource?: 'air' | 'ground';
    /**
     * Where power and COP come from: left out for the Navigator, `external` for the external meters (Navigator values where
     * there is no external one).
     */
    source?: 'external';
    /** the COP rows: left out for one COP that follows the source */
    cop?: 'both' | 'none';
    /** `separate`: the heating buffer is a vessel of its own next to the hot water vessel; left out for one combined vessel */
    storage?: 'separate';
    /** parts the user does not want to see */
    hidden: string[];
    /** which heating circuit the rooms of a zone module stand next to (a zone without an entry follows its number) */
    zoneCircuit: { zone: number; circuit: string }[];
}

/**
 * Read the diagram settings. Unknown parts, zones and circuits are dropped with a warning (CLAUDE.md rule 18).
 *
 * @param config adapter configuration
 */
export function readDiagramSettings(config: Partial<ioBroker.AdapterConfig>): {
    settings: DiagramSettings;
    warnings: string[];
} {
    const warnings: string[] = [];
    const hidden = (Array.isArray(config.diagramHidden) ? config.diagramHidden : []).filter(part => {
        const known = (DIAGRAM_PARTS as readonly string[]).includes(part);
        if (!known) {
            warnings.push(`Diagram: unknown part "${String(part)}" ignored`);
        }
        return known;
    });
    const zoneCircuit: DiagramSettings['zoneCircuit'] = [];
    for (const entry of Array.isArray(config.diagramZoneCircuit) ? config.diagramZoneCircuit : []) {
        const zone = Number(entry?.zone);
        const circuit = String(entry?.circuit ?? '').toUpperCase();
        if (
            !Number.isInteger(zone) ||
            zone < 1 ||
            zone > MAX_DIAGRAM_ZONE ||
            !(HEATING_CIRCUITS as readonly string[]).includes(circuit)
        ) {
            warnings.push(`Diagram: row zone module ${String(entry?.zone)} -> circuit ${circuit} ignored`);
        } else if (zoneCircuit.some(known => known.zone === zone)) {
            warnings.push(`Diagram: zone module ${zone} is assigned twice, the first row counts`);
        } else {
            zoneCircuit.push({ zone, circuit });
        }
    }
    const source = config.diagramHeatSource;
    // before the source setting existed, the COP row had its own choice: "external" meant the external meters
    const external = config.diagramSource === 'external' || config.diagramCop === 'external';
    const rows = (DIAGRAM_COP_ROWS as readonly string[]).includes(String(config.diagramCop))
        ? (config.diagramCop as (typeof DIAGRAM_COP_ROWS)[number])
        : 'source';
    return {
        settings: {
            ...(source === 'air' || source === 'ground' ? { heatSource: source } : {}),
            ...(external ? { source: 'external' as const } : {}),
            ...(rows !== 'source' ? { cop: rows } : {}),
            ...(config.diagramStorage === 'separate' ? { storage: 'separate' as const } : {}),
            hidden,
            zoneCircuit,
        },
        warnings,
    };
}
