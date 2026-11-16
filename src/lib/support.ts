import { HEATING_CIRCUITS } from './registers/plant';

/** The configuration values a support report carries (a whitelist: nothing else is ever copied, so no host, PIN or state id). */
const SUPPORT_SETTING_KEYS = [
    'family',
    'port',
    'unitId',
    'requestTimeoutMs',
    'requestPauseMs',
    'intervalFastS',
    'intervalMediumS',
    'intervalSlowS',
    'intervalConfigS',
    ...HEATING_CIRCUITS.map(letter => `hc${letter}`),
    'zoneModules',
    'roomsPerZone',
    'blockSolar',
    'blockIsc',
    'blockCascade',
    'blockBivalence',
    'blockPv',
    'blockBooster',
    'hideUnavailable',
    'removeInactiveStates',
    'writeSystem',
    'writeDhw',
    'writeZones',
    'writeExpert',
    'writeSolar',
    'eepromMinIntervalS',
    'dailyWriteWarn',
    'statsEnabled',
    'thermalSource',
    'currency',
    'pvEnabled',
    'pvIntervalS',
    'pvMaxAgeS',
    'pvSurplusMode',
    'roomsEnabled',
    'gltEnabled',
    'boostEnabled',
    'boostTargetC',
    'boostMaxMinutes',
    'webEnabled',
    'webPort',
    'webIntervalS',
    'webStatisticsIntervalS',
];

/**
 * The settings of a support report: the whitelisted values, and for what holds state ids or names only how many are set.
 *
 * @param config the adapter configuration
 */
export function supportSettings(config: Record<string, unknown>): Record<string, unknown> {
    const settings: Record<string, unknown> = Object.fromEntries(SUPPORT_SETTING_KEYS.map(key => [key, config[key]]));
    settings.heatingCircuitNamesSet = HEATING_CIRCUITS.filter(letter => config[`hcName${letter}`]).length;
    for (const key of ['pvSources', 'roomSources', 'gltSources']) {
        settings[key] = Array.isArray(config[key]) ? config[key].length : 0;
    }
    settings.externalMeters = ['extElecCounterId', 'extElecPowerId', 'extHeatCounterId', 'extHeatPowerId'].filter(
        key => config[key],
    ).length;
    return settings;
}

/** Everything the support report is built from; the adapter fills it, no host names or credentials go in. */
export interface SupportInput {
    /** adapter version */
    adapterVersion: string;
    /** Node.js version */
    nodeVersion: string;
    /** js-controller version, `null` when unknown */
    controllerVersion: string | null;
    /** ioBroker system language */
    language: string;
    /** the non-secret configuration values (a whitelist chosen by the adapter) */
    settings: Record<string, unknown>;
    /** connection and request state */
    runtime: Record<string, unknown>;
    /** number of enabled registers and the problem registers */
    registers: { enabled: number; absent: string[]; invalidReadings: Record<string, number> };
    /** latest reading of every register: the value (or `null` = invalid) and how old it is in seconds */
    samples: Record<string, { value: number | null; ageSeconds: number }>;
    /** summary and suggestion of the last device scan, or `null` */
    scan: unknown;
    /** write counters per register, or `null` */
    writes: unknown;
    /** state of the optional modules (PV, rooms, GLT, web interface, boost) */
    modules: Record<string, unknown>;
}

/** The report as written to the file. */
export interface SupportReport extends SupportInput {
    /** what this file is */
    description: string;
    /** time of creation */
    generatedAt: string;
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Keys (split at camelCase and underscores) that name a credential or an address of the installation. */
const SECRET_KEY = /(^|_)(host|hostname|ip|pin|password|passwd|token|secret|apikey|cookie|csrf|authorization)(_|$)/;
const isSecretKey = (key: string): boolean => SECRET_KEY.test(key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());

/**
 * Remove what must not leave the installation from a value: IP addresses and e-mail addresses in texts, and the content of
 * keys that sound like credentials (CLAUDE.md rule 3).
 *
 * @param value any JSON-like value
 */
export function redact(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.replace(IPV4, '<ip>').replace(EMAIL, '<email>');
    }
    if (Array.isArray(value)) {
        return value.map(redact);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
                key,
                isSecretKey(key) ? '<removed>' : redact(item),
            ]),
        );
    }
    return value;
}

/**
 * Build the support report: the input, redacted, with a description and the time.
 *
 * @param input what the adapter collected
 * @param now the time of creation
 */
export function buildSupportReport(input: SupportInput, now: Date): SupportReport {
    return redact({
        description:
            'Support report of the idm-modbus adapter: configuration (without hosts, PINs and state ids), connection state, problem registers and the latest readings. Attach it to a bug report.',
        generatedAt: now.toISOString(),
        ...input,
    }) as SupportReport;
}
