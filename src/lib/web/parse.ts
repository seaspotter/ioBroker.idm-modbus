/** A room as the Navigator's web interface reports it (`data/rooms.php`). */
export interface WebRoom {
    /** the web interface's room id (101 = zone module 1, room 1) */
    id: number;
    /** zone module number derived from the id, `null` if the id does not follow the pattern */
    zone: number | null;
    /** room number within the zone module */
    room: number | null;
    /** the name set in the Navigator */
    name: string;
    /** operating mode as text, e.g. `auto_normal` */
    mode: string;
    /** measured room temperature in °C, `null` when the room has no temperature (shown as `--.-`) */
    actual: number | null;
    /** current target temperature in °C */
    target: number | null;
    /** relative humidity in %, `null` when the room has no humidity sensor */
    humidity: number | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        return Number(value);
    }
    return null;
};

/**
 * Read the room list of `data/rooms.php`. Rooms without a usable id or name are dropped. The web interface numbers rooms
 * `zone * 100 + room` (101 to 109 on the test device); other ids still get a state but no zone assignment.
 *
 * @param json the parsed response
 */
export function parseRooms(json: unknown): WebRoom[] {
    if (!Array.isArray(json)) {
        return [];
    }
    const rooms: WebRoom[] = [];
    for (const entry of json as Record<string, unknown>[]) {
        const id = asNumber(entry?.id);
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (id === null || !Number.isInteger(id) || id < 0 || !name) {
            continue;
        }
        const zone = Math.floor(id / 100);
        const room = id % 100;
        const temperature = (entry.temperature ?? {}) as Record<string, unknown>;
        rooms.push({
            id,
            zone: zone >= 1 && zone <= 10 && room >= 1 ? zone : null,
            room: zone >= 1 && zone <= 10 && room >= 1 ? room : null,
            name,
            mode: typeof entry.mode === 'string' ? entry.mode : '',
            actual: asNumber(temperature.actual),
            target: asNumber(temperature.target),
            humidity: asNumber(entry.humidity),
        });
    }
    return rooms;
}

/**
 * Read the heating circuit names of `data/heatpump.php`.
 *
 * @param json the parsed response
 * @returns names by circuit letter (`A`..`G`)
 */
export function parseCircuitNames(json: unknown): Record<string, string> {
    const names: Record<string, string> = {};
    const circuits = (json as { hk?: unknown } | null)?.hk;
    if (Array.isArray(circuits)) {
        for (const circuit of circuits as Record<string, unknown>[]) {
            const letter = typeof circuit?.hk === 'string' ? circuit.hk.trim().toUpperCase() : '';
            const name = typeof circuit?.name === 'string' ? circuit.name.trim() : '';
            if (/^[A-G]$/.test(letter) && name) {
                names[letter] = name;
            }
        }
    }
    return names;
}

/** Statistics pages of the web interface, with the query that selects them. */
export const WEB_STATISTICS = {
    runtime: { query: 'statistics.php?type=heatpump', unit: 'h' },
    heat: { query: 'statistics.php?type=amountofheat', unit: 'kWh' },
    electricity: { query: 'statistics.php?type=baenergyhp', unit: 'kWh' },
} as const;

/** The kinds of statistics. */
export type WebStatisticsKind = keyof typeof WEB_STATISTICS;

/** Operating states the statistics are split by. */
export type WebCategory = 'heating' | 'cooling' | 'hot_water' | 'defrost';

/** One period of a statistics table (a day, a month or a year). */
export interface WebPeriod {
    /** the label the web interface shows: `10.10` (day.month), `2026.10` or `2026` */
    name: string;
    /** values by category in the base unit (h or kWh); a category the page does not report for this period is missing */
    values: Partial<Record<WebCategory, number>>;
}

/** A statistics table: lifetime totals and the periods, newest first. */
export interface WebStatistics {
    /** the page lists categories, but none has a name the adapter knows (the Navigator is probably not set to German) */
    unknownLanguage?: boolean;
    /** lifetime totals by category in the base unit */
    total: Partial<Record<WebCategory, number>>;
    /** the last days, today first */
    daily: WebPeriod[];
    /** the months, the current one first */
    monthly: WebPeriod[];
    /** the years, the current one first */
    yearly: WebPeriod[];
}

/** Category names as the pages report them (German and English firmware). */
const CATEGORY_NAMES: Record<string, WebCategory> = {
    heizen: 'heating',
    heating: 'heating',
    kühlen: 'cooling',
    kühlung: 'cooling',
    cooling: 'cooling',
    warmwasser: 'hot_water',
    'hot water': 'hot_water',
    'domestic hot water': 'hot_water',
    abtauung: 'defrost',
    defrost: 'defrost',
};

/** Factors from the unit of the lifetime totals (`unitTotal`) to the base unit. */
const TOTAL_UNIT_FACTORS: Record<string, number> = { h: 1, wh: 0.001, kwh: 1, mwh: 1000, gwh: 1000000 };

/**
 * Read one statistics page. The categories come from `items` (rows of columns), the values of a period are arranged the same
 * way. Unknown category names are ignored; periods and totals without a number are left out. The totals are given in
 * `unitTotal` (kWh, MWh, ...), the periods already in the base unit (h or kWh, also where the page prints the sum in MWh).
 *
 * @param json the parsed response
 * @returns the table, or `null` if the page does not have the expected shape
 */
export function parseStatistics(json: unknown): WebStatistics | null {
    const page = json as { data?: Record<string, unknown>; items?: unknown } | null;
    const data = page?.data;
    if (!data || !Array.isArray(page?.items)) {
        return null;
    }
    const slugs = (page.items as unknown[]).map(row =>
        Array.isArray(row)
            ? (row as { name?: unknown }[]).map(item => CATEGORY_NAMES[text(item?.name).trim().toLowerCase()])
            : [],
    );
    const period = (entry: unknown): WebPeriod | null => {
        const e = entry as { name?: unknown; values?: unknown } | null;
        if (typeof e?.name !== 'string' || !Array.isArray(e.values)) {
            return null;
        }
        // a row of categories the page leaves out for a period (e.g. no defrost today) means nothing happened: 0
        const values: WebPeriod['values'] = {};
        for (const slug of slugs.flat()) {
            if (slug) {
                values[slug] = 0;
            }
        }
        (e.values as unknown[]).forEach((row, r) => {
            if (Array.isArray(row)) {
                (row as unknown[]).forEach((value, c) => {
                    const slug = slugs[r]?.[c];
                    if (slug && typeof value === 'number' && Number.isFinite(value)) {
                        values[slug] = value;
                    }
                });
            }
        });
        return { name: e.name, values };
    };
    const periods = (list: unknown): WebPeriod[] =>
        Array.isArray(list) ? list.map(period).filter((p): p is WebPeriod => p !== null) : [];
    const factor = TOTAL_UNIT_FACTORS[text(data.unitTotal).trim().toLowerCase()] ?? NaN;
    const total: WebStatistics['total'] = {};
    if (Number.isFinite(factor) && Array.isArray(data.total)) {
        for (const entry of data.total as { name?: unknown; value?: unknown }[]) {
            const slug = CATEGORY_NAMES[text(entry?.name).trim().toLowerCase()];
            if (slug && typeof entry.value === 'number' && Number.isFinite(entry.value)) {
                total[slug] = entry.value * factor;
            }
        }
    }
    const named = slugs.some(row => row.some(Boolean));
    return {
        ...(named || !slugs.some(row => row.length) ? {} : { unknownLanguage: true }),
        total,
        daily: periods(data.daily),
        monthly: periods(data.monthly),
        yearly: periods(data.yearly),
    };
}

/**
 * COP from heat and electricity; `null` when the electricity is too small to divide by (as the statistics module).
 *
 * @param heat heat quantity in kWh
 * @param electricity electrical energy in kWh
 */
export function copOf(heat: number | undefined, electricity: number | undefined): number | null {
    if (heat === undefined || electricity === undefined || electricity < 0.1) {
        return null;
    }
    return Math.round((heat / electricity) * 100) / 100;
}
