import type { PlannedObject } from '../object-tree';
import { channelObject, stateObject } from './objects';
import { copOf, WEB_STATISTICS, type WebCategory, type WebStatistics, type WebStatisticsKind } from './parse';

/** Categories in the order of the states; `all` is the sum of the others. */
const CATEGORIES: (WebCategory | 'all')[] = ['all', 'heating', 'cooling', 'hot_water', 'defrost'];
const CATEGORY_NAMES: Record<WebCategory | 'all', string> = {
    all: 'All operating states',
    heating: 'Heating',
    cooling: 'Cooling',
    hot_water: 'Hot water',
    defrost: 'Defrost',
};
const KIND_NAMES: Record<WebStatisticsKind, string> = {
    runtime: 'Runtime',
    heat: 'Heat quantity',
    electricity: 'Electrical energy',
};
const PERIODS = ['today', 'month', 'year', 'total'] as const;
const PERIOD_NAMES: Record<(typeof PERIODS)[number], string> = {
    today: 'Today',
    month: 'This month',
    year: 'This year',
    total: 'Total',
};
const COP_PERIODS = ['month', 'year', 'total'] as const;

/** The planned objects and the current values of the statistics states. */
export interface StatisticsStates {
    /** channels and states */
    objects: PlannedObject[];
    /** value per state id */
    values: Map<string, number | string | null>;
}

const sum = (values: Partial<Record<WebCategory, number>>): number | undefined => {
    const numbers = Object.values(values);
    return numbers.length ? numbers.reduce((a, b) => a + b, 0) : undefined;
};

/**
 * Hours and kWh with one decimal (the counters of the Navigator are not more exact than that).
 *
 * @param value the value, `undefined` when the page does not report it
 */
const round = (value: number | undefined): number | null => (value === undefined ? null : Math.round(value * 10) / 10);

/**
 * Turn the statistics pages into states: per kind (runtime, heat, electricity) and category (and `all`) the values for today,
 * this month, this year and in total, a JSON history of days, months and years, and the COP from heat and electricity.
 *
 * @param tables the parsed pages that could be read
 */
export function buildStatisticsStates(tables: Partial<Record<WebStatisticsKind, WebStatistics>>): StatisticsStates {
    const objects: PlannedObject[] = [];
    const values = new Map<string, number | string | null>();
    const channel = (id: string, name: string): number => objects.push(channelObject(id, name));
    const state = (...args: Parameters<typeof stateObject>): number => objects.push(stateObject(...args));
    channel('web.statistics', 'Statistics');
    const byKind = new Map<
        WebStatisticsKind,
        Record<(typeof PERIODS)[number], Partial<Record<WebCategory, number>> | undefined>
    >();
    for (const kind of Object.keys(WEB_STATISTICS) as WebStatisticsKind[]) {
        const table = tables[kind];
        if (!table) {
            continue;
        }
        const unit = WEB_STATISTICS[kind].unit;
        channel(`web.statistics.${kind}`, KIND_NAMES[kind]);
        const periods = {
            today: table.daily[0]?.values,
            month: table.monthly[0]?.values,
            year: table.yearly[0]?.values,
            total: table.total,
        };
        byKind.set(kind, periods);
        for (const category of CATEGORIES) {
            channel(`web.statistics.${kind}.${category}`, CATEGORY_NAMES[category]);
            for (const period of PERIODS) {
                const id = `web.statistics.${kind}.${category}.${period}`;
                state(id, PERIOD_NAMES[period], 'number', 'value', unit);
                const source = periods[period];
                values.set(id, round(source ? (category === 'all' ? sum(source) : source[category]) : undefined));
            }
        }
        state(`web.statistics.${kind}.history`, 'History (JSON)', 'string', 'json');
        values.set(
            `web.statistics.${kind}.history`,
            JSON.stringify({ daily: table.daily, monthly: table.monthly, yearly: table.yearly }),
        );
    }
    const heat = byKind.get('heat');
    const electricity = byKind.get('electricity');
    if (heat && electricity) {
        channel('web.statistics.cop', 'COP');
        for (const category of ['all', 'heating', 'cooling', 'hot_water'] as const) {
            channel(`web.statistics.cop.${category}`, CATEGORY_NAMES[category]);
            for (const period of COP_PERIODS) {
                const id = `web.statistics.cop.${category}.${period}`;
                state(id, PERIOD_NAMES[period], 'number', 'value');
                const h = heat[period];
                const e = electricity[period];
                values.set(
                    id,
                    h && e
                        ? copOf(category === 'all' ? sum(h) : h[category], category === 'all' ? sum(e) : e[category])
                        : null,
                );
            }
        }
    }
    return { objects, values };
}
